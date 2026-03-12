// GitHub API helpers for pushing files to a repo

function uint8ToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
  };
}

// Build a file entry for a text file (for use with pushFiles)
export function textEntry(path, content) {
  return { path, content: uint8ToBase64(new TextEncoder().encode(content)) };
}

// Build a file entry for a binary file (for use with pushFiles)
export function binaryEntry(path, data) {
  return { path, content: uint8ToBase64(new Uint8Array(data)) };
}

// Push multiple files in a single commit using the Git Data API.
// files: array of { path, content (base64) }
export async function pushFiles(token, repo, files, message) {
  const api = `https://api.github.com/repos/${repo}`;
  const headers = ghHeaders(token);

  // 1. Get current commit SHA on the default branch
  const refResp = await fetch(`${api}/git/ref/heads/main`, { headers });
  if (!refResp.ok) throw new Error('Failed to get branch ref');
  const baseSha = (await refResp.json()).object.sha;

  // 2. Get the tree SHA of the base commit
  const commitResp = await fetch(`${api}/git/commits/${baseSha}`, { headers });
  if (!commitResp.ok) throw new Error('Failed to get base commit');
  const baseTreeSha = (await commitResp.json()).tree.sha;

  // 3. Create blobs for each file in parallel
  const tree = await Promise.all(
    files.map(async (f) => {
      const blobResp = await fetch(`${api}/git/blobs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ content: f.content, encoding: 'base64' }),
      });
      if (!blobResp.ok) throw new Error(`Failed to create blob for ${f.path}`);
      return {
        path: f.path,
        mode: '100644',
        type: 'blob',
        sha: (await blobResp.json()).sha,
      };
    })
  );

  // 4. Create a new tree
  const treeResp = await fetch(`${api}/git/trees`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ base_tree: baseTreeSha, tree }),
  });
  if (!treeResp.ok) throw new Error('Failed to create tree');
  const treeSha = (await treeResp.json()).sha;

  // 5. Create a new commit
  const newCommitResp = await fetch(`${api}/git/commits`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message, tree: treeSha, parents: [baseSha] }),
  });
  if (!newCommitResp.ok) throw new Error('Failed to create commit');
  const newCommitSha = (await newCommitResp.json()).sha;

  // 6. Update the branch reference
  const updateResp = await fetch(`${api}/git/refs/heads/main`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ sha: newCommitSha }),
  });
  if (!updateResp.ok) throw new Error('Failed to update branch ref');
}
