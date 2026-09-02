export interface AppConfig {
  baseUrl: string;
  privateToken: string;
  groupPath: string;
}

export interface GitLabUser {
  id: number;
  name: string;
  username: string;
  email?: string;
  webUrl?: string;
}

export interface GitLabGroup {
  id: number | string;
  name: string;
  path: string;
  fullPath: string;
  webUrl?: string;
}

export interface GitLabProject {
  id: number | string;
  name: string;
  path: string;
  pathWithNamespace: string;
  namespacePath?: string;
  webUrl?: string;
  defaultBranch?: string;
  archived?: boolean;
}

export interface GroupContent {
  group: GitLabGroup;
  subgroups: GitLabGroup[];
  projects: GitLabProject[];
}

export interface GitLabCommit {
  id: string;
  shortId: string;
  title: string;
  message?: string;
  committedDate?: string;
  createdAt?: string;
  webUrl?: string;
}

export interface GitLabBranch {
  name: string;
  protected: boolean;
  default: boolean;
  merged?: boolean;
  canPush?: boolean;
  webUrl?: string;
  commit?: GitLabCommit;
}

export interface DeleteResult {
  branch: string;
  ok: boolean;
  message?: string;
}
