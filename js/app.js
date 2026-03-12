// Main application logic

import * as crypto from './crypto.js';
import * as auth from './auth.js';
import * as github from './github.js';
import * as feed from './feed.js';

const DEFAULT_FEED_LIMIT = 50;

// --- Helpers ---

function getDomain() {
  return window.location.hostname;
}

function getRepoName() {
  // e.g. "/satellite/" -> "satellite"
  return window.location.pathname.split('/').filter(Boolean)[0] || 'satellite';
}

function getState() {
  return {
    domain: getDomain(),
    repo: localStorage.getItem('satproto_github_repo'),
    token: auth.getStoredToken(),
  };
}

function getSecretKey() {
  return crypto.fromBase64(localStorage.getItem('satproto_secret_key'));
}

function getContentKey() {
  return crypto.fromBase64(localStorage.getItem('satproto_content_key'));
}

function setStatus(msg) {
  document.getElementById('status').textContent = msg;
}

function generatePostId() {
  const iso = new Date().toISOString();
  const compact = iso.replace(/-/g, '').replace(/:/g, '');
  const base = compact.split('.')[0] + 'Z';
  const hex = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, '0');
  return `${base}-${hex}`;
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function escAttr(s) {
  return (s || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

// --- UI ---

function showSetup() {
  document.getElementById('setup-panel').style.display = 'block';
  document.getElementById('main-ui').style.display = 'none';
  setStatus('Sign in with GitHub to get started.');
}

function showMain() {
  document.getElementById('setup-panel').style.display = 'none';
  document.getElementById('main-ui').style.display = 'block';
  document.getElementById('follow-panel').style.display = 'block';
}

// --- Bootstrap ---

async function pushSelfData(token, repo, contentKey) {
  const pk = crypto.fromBase64(localStorage.getItem('satproto_public_key'));
  const plaintext = new TextEncoder().encode(
    JSON.stringify({ content_key: crypto.toBase64(contentKey), repo, token })
  );
  const sealed = crypto.sealBox(plaintext, pk);
  await github.pushTextFile(
    token,
    repo,
    'keys/_self.json',
    JSON.stringify({ sealed_data: crypto.toBase64(sealed) })
  );
}

async function bootstrap() {
  const { token, repo, domain } = getState();
  const pk = localStorage.getItem('satproto_public_key');

  const contentKey = crypto.generateContentKey();
  localStorage.setItem('satproto_content_key', crypto.toBase64(contentKey));

  const files = [
    [
      'profile.json',
      JSON.stringify({
        satproto_version: '0.1.0',
        public_key: pk,
      }),
    ],
    ['follows/index.json', JSON.stringify({ follows: [] })],
    ['posts/index.json', JSON.stringify({ posts: [] })],
  ];

  for (const [path, content] of files) {
    await github.pushTextFile(token, repo, path, content);
  }
  await pushSelfData(token, repo, contentKey);
  console.log('Site bootstrapped!');
}

// --- Actions ---

async function refreshFollows() {
  const { domain } = getState();
  try {
    const list = await feed.fetchFollowList(domain);
    const el = document.getElementById('follows-list');
    if (list.follows.length === 0) {
      el.innerHTML = '<span class="follows-empty">Not following anyone yet</span>';
      return;
    }
    el.innerHTML = list.follows
      .map(
        (f) =>
          `<span class="follow-chip">${escHtml(f)} <button onclick="doUnfollow('${escAttr(f)}')" class="unfollow-btn">x</button></span>`
      )
      .join('');
  } catch (e) {
    console.warn('Failed to load follows:', e);
  }
}

async function refreshFeed() {
  const { domain } = getState();
  setStatus('Loading feed...');
  try {
    const followList = await feed.fetchFollowList(domain);
    const sk = getSecretKey();
    const postArrays = [];

    for (const followed of followList.follows) {
      try {
        const posts = await feed.fetchUserPosts(
          followed,
          domain,
          sk,
          DEFAULT_FEED_LIMIT
        );
        postArrays.push(posts);
      } catch (e) {
        console.warn(`Failed to fetch from ${followed}:`, e);
      }
    }

    const merged = feed.mergeFeed(postArrays);

    // Split into top-level posts and replies
    const topLevel = [];
    const replies = [];
    for (const post of merged) {
      if (post.reply_to) {
        replies.push(post);
      } else {
        topLevel.push(post);
      }
    }

    // Build a set of top-level post keys for quick lookup
    const topLevelKeys = new Set(
      topLevel.map((p) => p.author + '\0' + p.id)
    );

    // Group replies by parent, dropping replies to inaccessible posts
    const replyMap = new Map();
    for (const r of replies) {
      const key = r.reply_to_author + '\0' + r.reply_to;
      if (!topLevelKeys.has(key)) continue;
      if (!replyMap.has(key)) replyMap.set(key, []);
      replyMap.get(key).push(r);
    }

    // Sort each reply group by created_at ascending
    for (const group of replyMap.values()) {
      group.sort((a, b) => a.created_at.localeCompare(b.created_at));
    }

    // Attach replies to their parent
    for (const post of topLevel) {
      const key = post.author + '\0' + post.id;
      post._replies = replyMap.get(key) || [];
    }

    renderFeed(topLevel);
    setStatus(
      topLevel.length
        ? ''
        : 'No posts yet. Follow someone or write your first post!'
    );
  } catch (e) {
    setStatus('Error loading feed: ' + e);
  }
}

function renderFeed(posts) {
  const el = document.getElementById('feed');
  el.innerHTML = '';
  for (const post of posts) {
    const div = document.createElement('div');
    div.className = 'post';

    let html = '';
    html += `<span class="post-author">${escHtml(post.author)}</span>`;
    html += `<span class="post-time">${new Date(post.created_at).toLocaleString()}</span>`;
    html += `<div class="post-text">${escHtml(post.text)}</div>`;
    html += `<div class="post-actions">`;
    html += `<button onclick="doReply('${escAttr(post.id)}','${escAttr(post.author)}')">reply</button>`;
    html += `</div>`;

    if (post._replies && post._replies.length > 0) {
      for (const reply of post._replies) {
        html += `<div class="reply">`;
        html += `<span class="post-author">${escHtml(reply.author)}</span>`;
        html += `<span class="post-time">${new Date(reply.created_at).toLocaleString()}</span>`;
        html += `<div class="post-text">${escHtml(reply.text)}</div>`;
        html += `</div>`;
      }
    }

    div.innerHTML = html;
    el.appendChild(div);
  }
}

// --- Global handlers (called from HTML) ---

window.saveSetup = async function () {
  const username = document.getElementById('username-input').value.trim();
  const token = document.getElementById('token-input').value.trim();
  if (!username || !token) return alert('Username and token are required');

  setStatus('Initializing your site...');
  try {
    const repo = `${username}/${getRepoName()}`;
    localStorage.setItem('satproto_github_repo', repo);
    auth.storeToken(token);

    await bootstrap();
    showMain();
    setStatus('Ready! Write your first post or follow someone.');

    const sk = localStorage.getItem('satproto_secret_key');
    if (sk && confirm('Save your secret key now — you need it to sign back in after clearing your browser cache.\n\nCopy to clipboard?')) {
      navigator.clipboard.writeText(sk).then(
        () => alert('Secret key copied to clipboard. Store it somewhere safe!'),
        () => prompt('Copy your secret key:', sk)
      );
    }
  } catch (e) {
    setStatus('Initialization failed: ' + e);
  }
};

window.signIn = async function () {
  const sk = document.getElementById('secret-key-input').value.trim();
  if (!sk) return alert('Secret key is required');

  try {
    const domain = getDomain();
    const secretKey = crypto.fromBase64(sk);
    const publicKey = crypto.derivePublicKey(secretKey);

    // Fetch and decrypt self data from the site
    const base = await feed.getSatBase(domain);
    const resp = await fetch(`${base}/keys/_self.json`);
    if (!resp.ok) throw new Error('Could not fetch self data — has this site been initialized?');
    const envelope = await resp.json();
    const sealed = crypto.fromBase64(envelope.sealed_data);
    const decrypted = crypto.openSealedBox(sealed, secretKey);
    const selfData = JSON.parse(new TextDecoder().decode(decrypted));

    localStorage.setItem('satproto_github_repo', selfData.repo);
    auth.storeToken(selfData.token);
    localStorage.setItem('satproto_secret_key', sk);
    localStorage.setItem('satproto_public_key', crypto.toBase64(publicKey));
    localStorage.setItem('satproto_content_key', selfData.content_key);

    document.getElementById('public-key-display').textContent =
      `Public key: ${crypto.toBase64(publicKey)}`;
    showMain();
    await refreshFollows();
    await refreshFeed();
    setStatus('Signed in!');
  } catch (e) {
    alert('Sign in failed: ' + e);
  }
};

window.exportKeys = function () {
  const sk = localStorage.getItem('satproto_secret_key');
  if (!sk) return alert('No key to export');
  navigator.clipboard.writeText(sk).then(
    () => alert('Secret key copied to clipboard. Store it somewhere safe!'),
    () => prompt('Copy your secret key:', sk)
  );
};

window.reinitialize = async function () {
  if (
    !confirm(
      'Re-initialize your site? This will reset your profile and post index.'
    )
  )
    return;
  setStatus('Re-initializing...');
  try {
    await bootstrap();
    setStatus('Site re-initialized!');
    await refreshFeed();
  } catch (e) {
    setStatus('Re-initialize failed: ' + e);
  }
};

window.submitPost = async function () {
  const { domain, token, repo } = getState();
  const text = document.getElementById('post-text').value.trim();
  if (!text) return;

  const btn = document.getElementById('post-btn');
  btn.disabled = true;
  btn.textContent = 'Posting...';

  try {
    const id = generatePostId();
    const post = {
      id,
      author: domain,
      created_at: new Date().toISOString(),
      text,
    };

    const contentKey = getContentKey();
    const postJson = new TextEncoder().encode(JSON.stringify(post));
    const encrypted = crypto.encryptData(postJson, contentKey);

    await github.pushBinaryFile(
      token,
      repo,
      `posts/${id}.json.enc`,
      encrypted
    );

    // Update post index
    let index;
    try {
      index = await feed.fetchPostIndex(domain);
    } catch {
      index = { posts: [] };
    }
    index.posts.unshift(id);
    await github.pushTextFile(
      token,
      repo,
      'posts/index.json',
      JSON.stringify(index)
    );

    document.getElementById('post-text').value = '';
    await refreshFeed();
  } catch (e) {
    alert('Failed to post: ' + e);
  }

  btn.disabled = false;
  btn.textContent = 'Post';
};

window.doFollow = async function () {
  const { domain, token, repo } = getState();
  const target = document.getElementById('follow-domain-input').value.trim();
  if (!target) return;

  const btn = document.getElementById('follow-btn');
  btn.disabled = true;
  btn.textContent = 'Following...';

  try {
    // Fetch target's public key
    const profile = await feed.fetchProfile(target);
    const targetPk = crypto.fromBase64(profile.public_key);

    // Encrypt our content key for them
    const contentKey = getContentKey();
    const sealed = crypto.sealBox(contentKey, targetPk);
    const envelope = {
      recipient: target,
      encrypted_key: crypto.toBase64(sealed),
    };
    await github.pushTextFile(
      token,
      repo,
      `keys/${target}.json`,
      JSON.stringify(envelope)
    );

    // Update follow list
    let list;
    try {
      list = await feed.fetchFollowList(domain);
    } catch {
      list = { follows: [] };
    }
    if (!list.follows.includes(target)) {
      list.follows.push(target);
    }
    await github.pushTextFile(
      token,
      repo,
      'follows/index.json',
      JSON.stringify(list)
    );

    document.getElementById('follow-domain-input').value = '';
    await refreshFollows();
    await refreshFeed();
  } catch (e) {
    alert('Failed to follow: ' + e);
  }

  btn.disabled = false;
  btn.textContent = 'Follow';
};

window.doUnfollow = async function (target) {
  if (!confirm(`Unfollow ${target}? This will re-encrypt all your posts.`))
    return;

  const { domain, token, repo } = getState();
  setStatus(`Unfollowing ${target}...`);

  try {
    const oldContentKey = getContentKey();

    // Fetch post index
    let index;
    try {
      index = await feed.fetchPostIndex(domain);
    } catch {
      index = { posts: [] };
    }

    // Generate new content key
    const newContentKey = crypto.generateContentKey();
    localStorage.setItem('satproto_content_key', crypto.toBase64(newContentKey));

    // Re-encrypt each post
    for (const postId of index.posts) {
      try {
        const resp = await fetch(
          `https://${domain}/${repo}/posts/${postId}.json.enc`
        );
        if (!resp.ok) continue;
        const encrypted = new Uint8Array(await resp.arrayBuffer());
        const decrypted = crypto.decryptData(encrypted, oldContentKey);
        const reEncrypted = crypto.encryptData(decrypted, newContentKey);
        await github.pushBinaryFile(
          token,
          repo,
          `posts/${postId}.json.enc`,
          reEncrypted
        );
      } catch (e) {
        console.warn(`Failed to re-encrypt post ${postId}:`, e);
      }
    }

    // Update follow list
    let list;
    try {
      list = await feed.fetchFollowList(domain);
    } catch {
      list = { follows: [] };
    }
    list.follows = list.follows.filter((d) => d !== target);

    // Re-create key envelopes for remaining followers
    for (const follower of list.follows) {
      try {
        const profile = await feed.fetchProfile(follower);
        const pk = crypto.fromBase64(profile.public_key);
        const sealed = crypto.sealBox(newContentKey, pk);
        const envelope = {
          recipient: follower,
          encrypted_key: crypto.toBase64(sealed),
        };
        await github.pushTextFile(
          token,
          repo,
          `keys/${follower}.json`,
          JSON.stringify(envelope)
        );
      } catch (e) {
        console.warn(`Failed to update key for ${follower}:`, e);
      }
    }

    await github.pushTextFile(
      token,
      repo,
      'follows/index.json',
      JSON.stringify(list)
    );

    await pushSelfData(token, repo, newContentKey);

    await refreshFollows();
    await refreshFeed();
  } catch (e) {
    alert('Failed to unfollow: ' + e);
  }
};

window.doReply = async function (postId, postAuthor) {
  const text = prompt('Reply:');
  if (!text) return;
  const { domain, token, repo } = getState();
  try {
    const id = generatePostId();
    const post = {
      id,
      author: domain,
      created_at: new Date().toISOString(),
      text,
      reply_to: postId,
      reply_to_author: postAuthor,
    };

    const contentKey = getContentKey();
    const postJson = new TextEncoder().encode(JSON.stringify(post));
    const encrypted = crypto.encryptData(postJson, contentKey);

    await github.pushBinaryFile(
      token,
      repo,
      `posts/${id}.json.enc`,
      encrypted
    );

    let index;
    try {
      index = await feed.fetchPostIndex(domain);
    } catch {
      index = { posts: [] };
    }
    index.posts.unshift(id);
    await github.pushTextFile(
      token,
      repo,
      'posts/index.json',
      JSON.stringify(index)
    );

    await refreshFeed();
  } catch (e) {
    alert('Failed to reply: ' + e);
  }
};


// --- Init ---

function updateTokenLink() {
  const username = document.getElementById('username-input').value.trim();
  const hint = document.getElementById('token-hint');
  if (!username) {
    hint.style.display = 'none';
    return;
  }
  const repoName = getRepoName();
  const params = new URLSearchParams({
    name: 'sAT Proto',
    description: `Choose "Only select repositories"\nSelect "${repoName}"\nClick "Add permissions"\nChoose "Contents"\nSet "Access: Read and write"`,
    target_name: username,
  });
  document.getElementById('token-link').href =
    `https://github.com/settings/personal-access-tokens/new?${params}`;
  document.getElementById('repo-hint').textContent = repoName;
  hint.style.display = '';
}

async function start() {
  await crypto.init();

  // Generate keypair if needed
  if (!localStorage.getItem('satproto_secret_key')) {
    const kp = crypto.generateKeypair();
    localStorage.setItem('satproto_secret_key', crypto.toBase64(kp.secretKey));
    localStorage.setItem('satproto_public_key', crypto.toBase64(kp.publicKey));
    console.log('Generated new keypair');
  }

  const pk = localStorage.getItem('satproto_public_key');
  document.getElementById('public-key-display').textContent =
    `Public key: ${pk}`;

  document.getElementById('username-input')
    .addEventListener('input', updateTokenLink);

  const { repo, token } = getState();
  if (repo && token) {
    showMain();
    await refreshFollows();
    await refreshFeed();
  } else {
    showSetup();
  }
}

start().catch((e) => {
  setStatus('Failed to initialize: ' + e);
  console.error(e);
});
