// Fetch and aggregate feeds from other users' sites

import * as crypto from './crypto.js';

const DEFAULT_BASE = 'satellite';

// Resolve which repo a user's data lives in.
// Checks .well-known/satproto.json at the domain root first (in case the user
// has a custom repo name or an unrelated project called "satellite"), then
// falls back to the default /satellite/ path.
async function resolveBase(domain) {
  const resp = await fetch(`https://${domain}/.well-known/satproto.json`);
  if (resp.ok) {
    const data = await resp.json();
    if (data.sat_root) return data.sat_root;
  }
  return DEFAULT_BASE;
}

// Get the base URL for a user's sat data (e.g. "https://alice.com/satellite")
export async function getSatBase(domain) {
  const base = await resolveBase(domain);
  return `https://${domain}/${base}`;
}

export async function fetchProfile(domain) {
  const base = await getSatBase(domain);
  const resp = await fetch(`${base}/profile.json`);
  if (!resp.ok) throw new Error(`Profile not found for ${domain}`);
  return resp.json();
}

export async function fetchFollowList(domain) {
  const base = await getSatBase(domain);
  const resp = await fetch(`${base}/follows/index.json`);
  if (!resp.ok) throw new Error(`Follow list not found for ${domain}`);
  return resp.json();
}

export async function fetchPostIndex(domain) {
  const base = await getSatBase(domain);
  const resp = await fetch(`${base}/posts/index.json`);
  if (!resp.ok) throw new Error(`Post index not found for ${domain}`);
  return resp.json();
}

async function fetchKeyEnvelope(satBase, myDomain, mySecret) {
  const resp = await fetch(`${satBase}/keys/${myDomain}.json`);
  if (!resp.ok) throw new Error(`No key envelope for ${myDomain}`);
  const envelope = await resp.json();
  const sealed = crypto.fromBase64(envelope.encrypted_key);
  return crypto.openSealedBox(sealed, mySecret);
}

async function fetchPost(satBase, postId, contentKey) {
  const resp = await fetch(`${satBase}/posts/${postId}.json.enc`);
  if (!resp.ok) throw new Error(`Post ${postId} not found`);
  const encrypted = new Uint8Array(await resp.arrayBuffer());
  const decrypted = crypto.decryptData(encrypted, contentKey);
  return JSON.parse(new TextDecoder().decode(decrypted));
}

export async function fetchUserPosts(domain, myDomain, mySecret, limit = 50) {
  const base = await getSatBase(domain);
  const contentKey = await fetchKeyEnvelope(base, myDomain, mySecret);
  const resp = await fetch(`${base}/posts/index.json`);
  if (!resp.ok) throw new Error(`Post index not found for ${domain}`);
  const index = await resp.json();
  const posts = [];
  for (const postId of index.posts.slice(0, limit)) {
    try {
      posts.push(await fetchPost(base, postId, contentKey));
    } catch (e) {
      console.warn(`Failed to fetch post ${postId} from ${domain}:`, e);
    }
  }
  return posts;
}

export async function fetchSinglePost(domain, postId, myDomain, mySecret) {
  const base = await getSatBase(domain);
  const contentKey = await fetchKeyEnvelope(base, myDomain, mySecret);
  return fetchPost(base, postId, contentKey);
}

export function mergeFeed(postArrays) {
  return postArrays.flat().sort((a, b) =>
    b.created_at.localeCompare(a.created_at)
  );
}
