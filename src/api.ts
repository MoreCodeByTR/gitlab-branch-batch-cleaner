import type {
  AppConfig,
  DeleteResult,
  GitLabBranch,
  GitLabUser,
  GroupContent
} from './types';

async function postJSON<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data?.message || data?.error || `${response.status} ${response.statusText}`;
    const error = new Error(message) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }

  return data as T;
}

async function getJSON<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    headers: {
      Accept: 'application/json'
    }
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data?.message || data?.error || `${response.status} ${response.statusText}`;
    const error = new Error(message) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }

  return data as T;
}

export function getStoredConfig() {
  return getJSON<AppConfig>('/api/config');
}

export function saveStoredConfig(config: AppConfig) {
  return postJSON<AppConfig>('/api/config', config);
}

export function fetchCurrentUser() {
  return postJSON<{ user: GitLabUser }>('/api/gitlab/current-user', {});
}

export function fetchGroupContent(groupPath: string) {
  return postJSON<GroupContent>('/api/gitlab/group-content', { groupPath });
}

export function fetchProject(projectPath: string) {
  return postJSON<{ project: GroupContent['projects'][number] }>('/api/gitlab/project', { projectPath });
}

export function fetchBranches(projectId: number | string) {
  return postJSON<{ branches: GitLabBranch[] }>('/api/gitlab/branches', {
    projectId
  });
}

export function deleteBranch(projectId: number | string, branch: string) {
  return postJSON<DeleteResult>('/api/gitlab/delete-branch', {
    projectId,
    branch
  });
}
