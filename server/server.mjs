import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');
const distRoot = path.join(packageRoot, 'dist');
const appName = 'GitLab Branch Batch Cleaner';
const defaultConfigBase = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const configRoot =
  process.env.GITLAB_BRANCH_BATCH_CLEANER_CONFIG_DIR ||
  process.env.GITLAB_BRANCH_CLEANER_CONFIG_DIR ||
  path.join(defaultConfigBase, 'gitlab-branch-batch-cleaner');
const configFile = path.join(configRoot, 'config.json');
const legacyConfigFile = path.join(defaultConfigBase, 'gitlab-branch-cleaner', 'config.json');

const defaultConfig = {
  baseUrl: 'https://git.17zjh.com',
  privateToken: '',
  groupPath: 'ivy_love/front-end'
};

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon']
]);

function normalizeConfig(value = {}) {
  return {
    baseUrl: typeof value.baseUrl === 'string' && value.baseUrl.trim() ? value.baseUrl.trim() : defaultConfig.baseUrl,
    privateToken: typeof value.privateToken === 'string' ? value.privateToken.trim() : '',
    groupPath: typeof value.groupPath === 'string' && value.groupPath.trim() ? value.groupPath.trim() : defaultConfig.groupPath
  };
}

async function readStoredConfig() {
  try {
    const raw = await fs.readFile(configFile, 'utf8');
    return normalizeConfig(JSON.parse(raw));
  } catch {
    try {
      const raw = await fs.readFile(legacyConfigFile, 'utf8');
      return normalizeConfig(JSON.parse(raw));
    } catch {
      return { ...defaultConfig };
    }
  }
}

async function writeStoredConfig(value) {
  const config = normalizeConfig(value);
  await fs.mkdir(configRoot, { recursive: true, mode: 0o700 });
  await fs.writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(configFile, 0o600).catch(() => {});
  return config;
}

function mergeGitLabOptions(config, payload = {}) {
  return normalizeConfig({
    ...config,
    ...payload.config,
    baseUrl: payload.baseUrl ?? payload.config?.baseUrl ?? config.baseUrl,
    privateToken: payload.privateToken ?? payload.config?.privateToken ?? config.privateToken,
    groupPath: payload.groupPath ?? payload.config?.groupPath ?? config.groupPath
  });
}

async function resolveGitLabOptions(payload) {
  return mergeGitLabOptions(await readStoredConfig(), payload);
}

function normalizeBaseUrl(baseUrl) {
  if (!baseUrl || typeof baseUrl !== 'string') {
    throw new Error('请填写 GitLab Base URL');
  }

  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

function encodeProjectId(value) {
  return encodeURIComponent(String(value));
}

function encodeGitLabPath(value) {
  return encodeURIComponent(String(value).replace(/^\/+|\/+$/g, ''));
}

function absoluteGitLabUrl(baseUrl, value) {
  if (!value) {
    return undefined;
  }

  try {
    return new URL(value, normalizeBaseUrl(baseUrl)).toString();
  } catch {
    return value;
  }
}

function headersForToken(privateToken) {
  const headers = {
    Accept: 'application/json'
  };

  if (privateToken) {
    headers['PRIVATE-TOKEN'] = privateToken;
  }

  return headers;
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function sendJSON(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(payload));
}

async function parseGitLabResponse(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function gitlabFetch({ baseUrl, privateToken, pathname, searchParams, method = 'GET' }) {
  const url = new URL(`${normalizeBaseUrl(baseUrl)}${pathname}`);
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const response = await fetch(url, {
    method,
    headers: headersForToken(privateToken)
  });
  const data = await parseGitLabResponse(response);

  if (!response.ok) {
    const message = data?.message || data?.error || (typeof data === 'string' ? data.slice(0, 240) : null);
    const error = new Error(message || `${response.status} ${response.statusText}`);
    error.status = response.status;
    throw error;
  }

  return { data, headers: response.headers };
}

function nextPageFrom(payload, headers, currentPage) {
  const xNextPage = headers.get('x-next-page');
  if (xNextPage) {
    return Number(xNextPage);
  }

  const nextPage =
    payload?.next_page ??
    payload?.nextPage ??
    payload?.pagination?.next_page ??
    payload?.pagination?.nextPage;
  if (nextPage) {
    return Number(nextPage);
  }

  const hasNext =
    payload?.has_next_page ??
    payload?.hasNextPage ??
    payload?.pagination?.has_next_page ??
    payload?.pagination?.hasNextPage;
  return hasNext ? currentPage + 1 : null;
}

async function fetchPaginated(options, pathname, searchParams = {}) {
  const items = [];
  let page = 1;

  while (page && page < 101) {
    const { data, headers } = await gitlabFetch({
      ...options,
      pathname,
      searchParams: {
        ...searchParams,
        per_page: 100,
        page
      }
    });

    if (Array.isArray(data)) {
      items.push(...data);
    }

    page = nextPageFrom(data, headers, page);
  }

  return items;
}

function normalizeGroup(group, baseUrl) {
  return {
    id: group.id,
    name: group.name,
    path: group.path,
    fullPath: group.full_path ?? group.fullPath ?? group.path,
    webUrl: absoluteGitLabUrl(baseUrl, group.web_url ?? group.webUrl)
  };
}

function normalizeProject(project, baseUrl) {
  const pathWithNamespace =
    project.path_with_namespace ??
    project.full_path ??
    project.name_with_namespace ??
    [project.namespace?.full_path, project.path || project.name].filter(Boolean).join('/');
  const namespacePath = project.namespace?.full_path ?? pathWithNamespace.split('/').slice(0, -1).join('/');

  return {
    id: project.id,
    name: project.name,
    path: project.path ?? pathWithNamespace.split('/').pop() ?? project.name,
    pathWithNamespace,
    namespacePath,
    webUrl: absoluteGitLabUrl(baseUrl, project.web_url ?? project.webUrl),
    defaultBranch: project.default_branch ?? project.defaultBranch,
    archived: Boolean(project.archived)
  };
}

function normalizeCommit(commit, baseUrl) {
  if (!commit) {
    return undefined;
  }

  return {
    id: commit.id,
    shortId: commit.short_id ?? String(commit.id || '').slice(0, 8),
    title: commit.title ?? commit.message?.split('\n')[0] ?? '',
    message: commit.message,
    committedDate: commit.committed_date,
    createdAt: commit.created_at,
    webUrl: absoluteGitLabUrl(baseUrl, commit.web_url ?? commit.webUrl)
  };
}

function normalizeBranch(branch, baseUrl) {
  return {
    name: branch.name,
    protected: Boolean(branch.protected),
    default: Boolean(branch.default),
    merged: Boolean(branch.merged),
    canPush: branch.can_push,
    webUrl: absoluteGitLabUrl(baseUrl, branch.web_url ?? branch.webUrl),
    commit: normalizeCommit(branch.commit, baseUrl)
  };
}

function normalizeUser(user, baseUrl) {
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    email: user.email,
    webUrl: absoluteGitLabUrl(baseUrl, user.web_url ?? user.webUrl)
  };
}

async function currentUser(payload) {
  const options = await resolveGitLabOptions(payload);
  const { data } = await gitlabFetch({
    ...options,
    pathname: '/api/v4/user'
  });

  return { user: normalizeUser(data, options.baseUrl) };
}

async function groupContent(payload) {
  const options = await resolveGitLabOptions(payload);
  const groupPath = payload.groupPath || options.groupPath;
  const encodedGroupPath = encodeGitLabPath(groupPath);
  const groupRequest = gitlabFetch({
    ...options,
    pathname: `/api/v4/groups/${encodedGroupPath}`
  });
  const subgroupsRequest = fetchPaginated(options, `/api/v4/groups/${encodedGroupPath}/subgroups`, {
    order_by: 'name',
    sort: 'asc'
  });
  const projectsRequest = fetchPaginated(options, `/api/v4/groups/${encodedGroupPath}/projects`, {
    include_subgroups: 'false',
    archived: 'false',
    order_by: 'name',
    sort: 'asc',
    simple: 'true'
  });

  const [{ data: group }, subgroups, projects] = await Promise.all([groupRequest, subgroupsRequest, projectsRequest]);

  return {
    group: normalizeGroup(group, options.baseUrl),
    subgroups: subgroups.map((item) => normalizeGroup(item, options.baseUrl)),
    projects: projects.map((item) => normalizeProject(item, options.baseUrl))
  };
}

async function projectByPath(payload) {
  const options = await resolveGitLabOptions(payload);
  const { data } = await gitlabFetch({
    ...options,
    pathname: `/api/v4/projects/${encodeGitLabPath(payload.projectPath)}`
  });

  return {
    project: normalizeProject(data, options.baseUrl)
  };
}

async function listBranches(payload) {
  const options = await resolveGitLabOptions(payload);
  const branches = await fetchPaginated(
    options,
    `/api/v4/projects/${encodeProjectId(payload.projectId)}/repository/branches`
  );

  return { branches: branches.map((branch) => normalizeBranch(branch, options.baseUrl)) };
}

async function removeBranch(payload) {
  const options = await resolveGitLabOptions(payload);
  const branchPath = `/api/v4/projects/${encodeProjectId(payload.projectId)}/repository/branches/${encodeURIComponent(
    payload.branch
  )}`;
  const { data: branch } = await gitlabFetch({
    ...options,
    pathname: branchPath
  });

  if (branch.default) {
    const error = new Error('默认分支不允许删除');
    error.status = 400;
    throw error;
  }

  if (branch.protected) {
    const error = new Error('受保护分支不允许删除');
    error.status = 400;
    throw error;
  }

  await gitlabFetch({
    ...options,
    method: 'DELETE',
    pathname: branchPath
  });

  return {
    branch: payload.branch,
    ok: true
  };
}

async function handleApi(request, response, url) {
  try {
    if (url.pathname === '/api/config') {
      if (request.method === 'GET') {
        sendJSON(response, 200, await readStoredConfig());
        return;
      }

      if (request.method === 'POST') {
        sendJSON(response, 200, await writeStoredConfig(await readBody(request)));
        return;
      }
    }

    if (request.method !== 'POST') {
      sendJSON(response, 405, { message: 'Method Not Allowed' });
      return;
    }

    const payload = await readBody(request);
    let result;

    switch (url.pathname) {
      case '/api/gitlab/current-user':
        result = await currentUser(payload);
        break;
      case '/api/gitlab/group-content':
        result = await groupContent(payload);
        break;
      case '/api/gitlab/project':
        result = await projectByPath(payload);
        break;
      case '/api/gitlab/branches':
        result = await listBranches(payload);
        break;
      case '/api/gitlab/delete-branch':
        result = await removeBranch(payload);
        break;
      default:
        sendJSON(response, 404, { message: 'Not Found' });
        return;
    }

    sendJSON(response, 200, result);
  } catch (error) {
    sendJSON(response, error.status || 500, {
      message: error.message || 'GitLab request failed'
    });
  }
}

async function sendStatic(request, response, url) {
  const requestedPath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const safePath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(distRoot, safePath);

  if (!filePath.startsWith(distRoot)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
  } catch {
    filePath = path.join(distRoot, 'index.html');
  }

  try {
    const ext = path.extname(filePath);
    const content = await fs.readFile(filePath);
    response.writeHead(200, {
      'Content-Type': contentTypes.get(ext) || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=31536000, immutable'
    });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch {
    response.writeHead(404);
    response.end('Not Found. Run npm run build before starting the package server.');
  }
}

function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
}

function createServer() {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      await handleApi(request, response, url);
      return;
    }

    await sendStatic(request, response, url);
  });
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

export async function startServer({ host = '127.0.0.1', port = 4178, shouldOpen = false } = {}) {
  let activePort = port;
  let server;

  for (let index = 0; index < 10; index += 1) {
    server = createServer();
    try {
      await listen(server, host, activePort);
      break;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') {
        throw error;
      }
      activePort += 1;
    }
  }

  if (!server?.listening) {
    throw new Error('没有可用端口，请使用 --port 指定其他端口。');
  }

  const url = `http://${host}:${activePort}`;
  console.log(`${appName} is running at ${url}`);
  if (shouldOpen) {
    openBrowser(url);
  }

  return { server, url };
}
