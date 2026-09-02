import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Copy,
  FileText,
  Folder,
  FolderGit2,
  GitBranch,
  Loader2,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Trash2,
  X
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import packageInfo from '../package.json';
import {
  deleteBranch,
  fetchBranches,
  fetchCurrentUser,
  fetchGroupContent,
  fetchProject,
  getStoredConfig,
  saveStoredConfig
} from './api';
import type {
  AppConfig,
  DeleteResult,
  GitLabBranch,
  GitLabGroup,
  GitLabProject,
  GitLabUser,
  GroupContent
} from './types';

const LEGACY_STORAGE_KEY = 'gitlab-branch-cleaner.config';
const STALE_DAYS = 90;

const defaultConfig: AppConfig = {
  baseUrl: 'https://git.17zjh.com',
  privateToken: '',
  groupPath: 'ivy_love/front-end'
};
const APP_VERSION = packageInfo.version;

type StatusKind = 'idle' | 'loading' | 'success' | 'error';
type ViewMode = 'group' | 'branches';
type BranchTab = 'overview' | 'active' | 'stale' | 'all';
type RouteWrite = 'push' | 'replace' | false;

interface StatusState {
  kind: StatusKind;
  text: string;
}

type AppRoute =
  | {
      view: 'group';
      groupPath: string;
    }
  | {
      view: 'branches';
      projectPath: string;
    };

function normalizeClientConfig(value: Partial<AppConfig> = {}): AppConfig {
  return {
    baseUrl: value.baseUrl?.trim() || defaultConfig.baseUrl,
    privateToken: value.privateToken?.trim() || '',
    groupPath: value.groupPath?.trim() || defaultConfig.groupPath
  };
}

function readLegacyConfig(): Partial<AppConfig> {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<AppConfig>) : {};
  } catch {
    return {};
  }
}

function decodePathSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function encodedPath(value: string) {
  const path = value
    .split('/')
    .filter(Boolean)
    .map((item) => encodeURIComponent(item))
    .join('/');
  return `/${path}`;
}

function groupHref(groupPath: string) {
  return encodedPath(groupPath);
}

function projectBranchesHref(projectPath: string) {
  return `${encodedPath(projectPath)}/-/branches`;
}

function parseRoute(fallbackGroupPath: string): AppRoute {
  const parts = window.location.pathname.split('/').filter(Boolean).map(decodePathSegment);
  const markerIndex = parts.findIndex((part, index) => part === '-' && parts[index + 1] === 'branches');

  if (markerIndex > 0) {
    return {
      view: 'branches',
      projectPath: parts.slice(0, markerIndex).join('/')
    };
  }

  return {
    view: 'group',
    groupPath: parts.join('/') || fallbackGroupPath
  };
}

function syncRoute(href: string, write: RouteWrite) {
  if (!write || window.location.pathname === href) {
    return;
  }

  if (write === 'replace') {
    window.history.replaceState(null, '', href);
    return;
  }

  window.history.pushState(null, '', href);
}

function shouldUseBrowserNavigation(event: MouseEvent<HTMLElement>) {
  return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0;
}

function errorStatus(error: unknown) {
  return typeof error === 'object' && error && 'status' in error ? Number((error as { status?: number }).status) : undefined;
}

function shortDate(date?: string) {
  if (!date) {
    return '';
  }

  const time = new Date(date).getTime();
  if (Number.isNaN(time)) {
    return '';
  }

  const delta = Date.now() - time;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  const month = 30 * day;
  const year = 365 * day;
  const safeDelta = Math.max(0, delta);

  if (safeDelta < minute) return '刚刚';
  if (safeDelta < hour) return `${Math.floor(safeDelta / minute)} 分钟前`;
  if (safeDelta < day) return `${Math.floor(safeDelta / hour)} 小时前`;
  if (safeDelta < week) return `${Math.floor(safeDelta / day)} 天前`;
  if (safeDelta < month) return `${Math.floor(safeDelta / week)} 周前`;
  if (safeDelta < year) return `${Math.floor(safeDelta / month)} 个月前`;
  return `${Math.floor(safeDelta / year)} 年前`;
}

function commitTime(branch: GitLabBranch) {
  const value = branch.commit?.committedDate || branch.commit?.createdAt;
  if (!value) {
    return 0;
  }

  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function sortBranches(branches: GitLabBranch[]) {
  return [...branches].sort((a, b) => {
    if (a.default !== b.default) return a.default ? -1 : 1;
    return commitTime(b) - commitTime(a) || a.name.localeCompare(b.name);
  });
}

function canDelete(branch: GitLabBranch) {
  return !branch.default && !branch.protected;
}

function isStale(branch: GitLabBranch) {
  const time = commitTime(branch);
  if (!time) {
    return false;
  }

  return Date.now() - time >= STALE_DAYS * 24 * 60 * 60 * 1000;
}

function branchInTab(branch: GitLabBranch, tab: BranchTab) {
  if (tab === 'all') return true;
  if (tab === 'active') return !isStale(branch);
  if (tab === 'stale') return isStale(branch);
  return branch.default || branch.protected;
}

function pathCrumbs(pathValue: string) {
  const parts = pathValue.split('/').filter(Boolean);
  return parts.map((label, index) => ({
    label,
    path: parts.slice(0, index + 1).join('/')
  }));
}

function normalizeSearchText(value: string) {
  return value.toLowerCase().replace(/[\s_-]+/g, '');
}

function matchesKeyword(values: Array<string | undefined>, keyword: string) {
  const terms = keyword.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return true;
  }

  const haystack = values.filter(Boolean).join(' ').toLowerCase();
  const compactHaystack = normalizeSearchText(haystack);
  return terms.every((term) => haystack.includes(term) || compactHaystack.includes(normalizeSearchText(term)));
}

function initials(...values: Array<string | undefined>) {
  const text = values.find((value) => value?.trim())?.trim();
  return text ? text.slice(0, 1).toUpperCase() : '?';
}

function projectGroupPath(project: GitLabProject) {
  return project.namespacePath || project.pathWithNamespace.split('/').slice(0, -1).join('/');
}

function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'blue' | 'red' }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

function EmptyState({ text }: { text: string }) {
  return <div className="empty-state">{text}</div>;
}

function ListLoading({ text }: { text: string }) {
  return (
    <div className="list-loading">
      <Loader2 className="spin" size={18} />
      <span>{text}</span>
    </div>
  );
}

export default function App() {
  const [booting, setBooting] = useState(true);
  const [config, setConfig] = useState<AppConfig>(defaultConfig);
  const [settingsDraft, setSettingsDraft] = useState<AppConfig>(defaultConfig);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [saveStatus, setSaveStatus] = useState<StatusState>({ kind: 'idle', text: '' });
  const [currentGroupPath, setCurrentGroupPath] = useState(defaultConfig.groupPath);
  const [currentProjectPath, setCurrentProjectPath] = useState('');
  const [groupContent, setGroupContent] = useState<GroupContent | null>(null);
  const [selectedProject, setSelectedProject] = useState<GitLabProject | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('group');
  const [user, setUser] = useState<GitLabUser | null>(null);
  const [userOpen, setUserOpen] = useState(false);
  const [groupSearch, setGroupSearch] = useState('');
  const [branchSearch, setBranchSearch] = useState('');
  const [branchTab, setBranchTab] = useState<BranchTab>('all');
  const [branches, setBranches] = useState<GitLabBranch[]>([]);
  const [selectedBranches, setSelectedBranches] = useState<Set<string>>(new Set());
  const [groupStatus, setGroupStatus] = useState<StatusState>({ kind: 'idle', text: '等待配置' });
  const [branchStatus, setBranchStatus] = useState<StatusState>({ kind: 'idle', text: '选择仓库后查看分支' });
  const [deleteQueue, setDeleteQueue] = useState<GitLabBranch[]>([]);
  const [confirmText, setConfirmText] = useState('');
  const [deleteResults, setDeleteResults] = useState<DeleteResult[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState<StatusState | null>(null);
  const toastTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      setBooting(true);
      try {
        const stored = await getStoredConfig();
        const legacy = readLegacyConfig();
        const hasStoredToken = Boolean(stored.privateToken);
        const initial = normalizeClientConfig(hasStoredToken ? stored : { ...stored, ...legacy });

        if (!hasStoredToken && legacy.privateToken) {
          await saveStoredConfig(initial).catch(() => {});
        }

        if (cancelled) {
          return;
        }

        setConfig(initial);
        setSettingsDraft(initial);
        setCurrentGroupPath(initial.groupPath);
        setSettingsOpen(false);

        if (initial.privateToken) {
          await Promise.allSettled([loadCurrentUser(), loadRoute(parseRoute(initial.groupPath), initial.groupPath, 'replace')]);
        } else {
          syncRoute(groupHref(initial.groupPath), 'replace');
          setGroupStatus({ kind: 'idle', text: '配置后自动获取仓库' });
        }
      } catch (error) {
        if (!cancelled) {
          setSettingsOpen(false);
          setGroupStatus({ kind: 'error', text: error instanceof Error ? error.message : '初始化失败' });
        }
      } finally {
        if (!cancelled) {
          setBooting(false);
        }
      }
    }

    boot();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (booting || !config.privateToken) {
      return undefined;
    }

    const handlePopState = () => {
      loadRoute(parseRoute(config.groupPath), config.groupPath, false);
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booting, config.privateToken, config.groupPath]);

  const breadcrumbPath =
    viewMode === 'branches' ? selectedProject?.pathWithNamespace || currentProjectPath || currentGroupPath : currentGroupPath;
  const breadcrumbs = pathCrumbs(breadcrumbPath);

  const filteredSubgroups = useMemo(() => {
    const items = groupContent?.subgroups || [];
    return items.filter((group) => matchesKeyword([group.name], groupSearch));
  }, [groupContent, groupSearch]);

  const filteredProjects = useMemo(() => {
    const items = groupContent?.projects || [];
    return items.filter((project) => matchesKeyword([project.name], groupSearch));
  }, [groupContent, groupSearch]);

  const sortedBranches = useMemo(() => sortBranches(branches), [branches]);
  const overviewCount = sortedBranches.filter((branch) => branch.default || branch.protected).length;
  const activeCount = sortedBranches.filter((branch) => branchInTab(branch, 'active')).length;
  const staleCount = sortedBranches.filter((branch) => branchInTab(branch, 'stale')).length;
  const branchTabs: Array<{ key: BranchTab; label: string; count: number }> = [
    { key: 'overview', label: 'Overview', count: overviewCount },
    { key: 'active', label: 'Active', count: activeCount },
    { key: 'stale', label: 'Stale', count: staleCount },
    { key: 'all', label: 'All', count: sortedBranches.length }
  ];

  const filteredBranches = useMemo(() => {
    const tabbed = sortedBranches.filter((branch) => branchInTab(branch, branchTab));
    return tabbed.filter((branch) => matchesKeyword([branch.name], branchSearch));
  }, [branchSearch, branchTab, sortedBranches]);

  const deletableBranches = filteredBranches.filter(canDelete);
  const allVisibleSelected =
    deletableBranches.length > 0 && deletableBranches.every((branch) => selectedBranches.has(branch.name));

  const selectedBranchObjects = useMemo(
    () => branches.filter((branch) => selectedBranches.has(branch.name) && canDelete(branch)),
    [branches, selectedBranches]
  );

  const groupFooterStatus = useMemo<StatusState>(() => {
    if (groupStatus.kind !== 'success' || !groupContent || !groupSearch.trim()) {
      return groupStatus;
    }

    return {
      kind: 'success',
      text: `筛选结果 ${filteredSubgroups.length} 个文件夹 · ${filteredProjects.length} 个仓库`
    };
  }, [filteredProjects.length, filteredSubgroups.length, groupContent, groupSearch, groupStatus]);

  const branchFooterStatus = useMemo<StatusState>(() => {
    if (branchStatus.kind !== 'success') {
      return branchStatus;
    }

    const text = branchSearch.trim()
      ? `筛选结果 ${filteredBranches.length}/${sortedBranches.length} 个分支`
      : `已获取 ${sortedBranches.length} 个分支`;

    return {
      kind: 'success',
      text: selectedBranchObjects.length > 0 ? `${text} · 已选 ${selectedBranchObjects.length} 个` : text
    };
  }, [branchSearch, branchStatus, filteredBranches.length, selectedBranchObjects.length, sortedBranches.length]);

  async function loadCurrentUser() {
    try {
      const result = await fetchCurrentUser();
      setUser(result.user);
    } catch {
      setUser(null);
      setUserOpen(false);
    }
  }

  async function loadRoute(route: AppRoute, fallbackGroupPath = config.groupPath, write: RouteWrite = false) {
    if (route.view === 'branches') {
      await openProjectPath(route.projectPath, write);
      return;
    }

    await loadGroup(route.groupPath || fallbackGroupPath, write, true);
  }

  async function loadGroup(groupPath = currentGroupPath, write: RouteWrite = 'push', fallbackToProject = false) {
    const nextGroupPath = groupPath || config.groupPath;
    const shouldResetSearch = viewMode !== 'group' || nextGroupPath !== currentGroupPath;

    syncRoute(groupHref(nextGroupPath), write);
    setViewMode('group');
    setCurrentGroupPath(nextGroupPath);
    setCurrentProjectPath('');
    setSelectedProject(null);
    setBranches([]);
    setSelectedBranches(new Set());
    setDeleteResults([]);
    setGroupContent(null);
    if (shouldResetSearch) {
      setGroupSearch('');
      setBranchSearch('');
    }
    setGroupStatus({ kind: 'loading', text: '正在获取仓库' });

    try {
      const result = await fetchGroupContent(nextGroupPath);
      setGroupContent(result);
      setGroupStatus({
        kind: 'success',
        text: `${result.subgroups.length} 个文件夹 · ${result.projects.length} 个仓库`
      });
    } catch (error) {
      if (fallbackToProject && errorStatus(error) === 404) {
        await openProjectPath(groupPath, 'replace');
        return;
      }
      setGroupStatus({ kind: 'error', text: error instanceof Error ? error.message : '获取仓库失败' });
    }
  }

  async function openProjectPath(projectPath: string, write: RouteWrite = 'push') {
    const shouldResetSearch = viewMode !== 'branches' || projectPath !== currentProjectPath;

    syncRoute(projectBranchesHref(projectPath), write);
    setSelectedProject(null);
    setCurrentProjectPath(projectPath);
    setCurrentGroupPath(projectPath.split('/').slice(0, -1).join('/') || config.groupPath);
    setViewMode('branches');
    if (shouldResetSearch) {
      setGroupSearch('');
      setBranchSearch('');
    }
    setBranchTab('all');
    setBranches([]);
    setSelectedBranches(new Set());
    setBranchStatus({ kind: 'loading', text: '正在获取仓库' });

    try {
      const result = await fetchProject(projectPath);
      setSelectedProject(result.project);
      setCurrentGroupPath(projectGroupPath(result.project));
      await loadBranches(result.project);
    } catch (error) {
      setBranchStatus({ kind: 'error', text: error instanceof Error ? error.message : '获取仓库失败' });
    }
  }

  async function openProject(project: GitLabProject, write: RouteWrite = 'push') {
    const projectPath = project.pathWithNamespace;
    const shouldResetSearch = viewMode !== 'branches' || projectPath !== currentProjectPath;

    syncRoute(projectBranchesHref(projectPath), write);
    setSelectedProject(project);
    setCurrentProjectPath(projectPath);
    setCurrentGroupPath(projectGroupPath(project));
    setViewMode('branches');
    if (shouldResetSearch) {
      setGroupSearch('');
      setBranchSearch('');
    }
    setBranchTab('all');
    await loadBranches(project);
  }

  async function loadBranches(project = selectedProject) {
    if (!project) {
      return;
    }

    setBranchStatus({ kind: 'loading', text: '正在获取分支' });
    setBranches([]);
    setSelectedBranches(new Set());
    setDeleteResults([]);

    try {
      const result = await fetchBranches(project.id);
      const sorted = sortBranches(result.branches);
      setBranches(sorted);
      setBranchStatus({ kind: 'success', text: `已获取 ${sorted.length} 个分支` });
    } catch (error) {
      setBranchStatus({ kind: 'error', text: error instanceof Error ? error.message : '获取分支失败' });
    }
  }

  async function saveSettings() {
    const next = normalizeClientConfig(settingsDraft);
    setSaveStatus({ kind: 'loading', text: '正在保存' });

    try {
      const saved = await saveStoredConfig(next);
      localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(saved));
      setConfig(saved);
      setSettingsDraft(saved);
      setSettingsOpen(false);
      setSaveStatus({ kind: 'success', text: '已保存' });
      setCurrentGroupPath(saved.groupPath);
      await Promise.allSettled([loadCurrentUser(), loadGroup(saved.groupPath, 'replace')]);
    } catch (error) {
      setSaveStatus({ kind: 'error', text: error instanceof Error ? error.message : '保存失败' });
    }
  }

  function toggleVisibleBranches(checked: boolean) {
    setSelectedBranches((current) => {
      const next = new Set(current);
      for (const branch of deletableBranches) {
        if (checked) {
          next.add(branch.name);
        } else {
          next.delete(branch.name);
        }
      }
      return next;
    });
  }

  function toggleBranch(branch: GitLabBranch, checked: boolean) {
    if (!canDelete(branch)) {
      return;
    }

    setSelectedBranches((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(branch.name);
      } else {
        next.delete(branch.name);
      }
      return next;
    });
  }

  function showToast(status: StatusState) {
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }

    setToast(status);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 1800);
  }

  async function copyText(text: string) {
    try {
      if (!navigator.clipboard) {
        throw new Error('Clipboard unavailable');
      }

      await navigator.clipboard.writeText(text);
      showToast({ kind: 'success', text: '已复制分支名' });
    } catch {
      showToast({ kind: 'error', text: '复制失败，请手动复制' });
    }
  }

  function openDeleteModal(items: GitLabBranch[]) {
    setDeleteQueue(items.filter(canDelete));
    setConfirmText('');
    setDeleteResults([]);
  }

  async function runDelete() {
    if (!selectedProject || confirmText !== 'DELETE' || deleting) {
      return;
    }

    const targetProject = selectedProject;
    const targetBranches = [...deleteQueue];
    setDeleting(true);
    setDeleteResults([]);
    setBranchStatus({ kind: 'loading', text: `正在删除 ${targetBranches.length} 个分支` });
    const results: DeleteResult[] = [];
    const removedBranches = new Set<string>();

    for (const branch of targetBranches) {
      try {
        const result = await deleteBranch(targetProject.id, branch.name);
        results.push(result);
        removedBranches.add(branch.name);
      } catch (error) {
        if (errorStatus(error) === 404) {
          results.push({ branch: branch.name, ok: true, message: '远端已不存在' });
          removedBranches.add(branch.name);
        } else {
          results.push({
            branch: branch.name,
            ok: false,
            message: error instanceof Error ? error.message : '删除失败'
          });
        }
      }
      setDeleteResults([...results]);
    }

    setBranches((current) => current.filter((item) => !removedBranches.has(item.name)));
    setSelectedBranches((current) => {
      const next = new Set(current);
      for (const branch of targetBranches) {
        next.delete(branch.name);
      }
      return next;
    });
    setDeleteQueue([]);
    setConfirmText('');
    setDeleteResults([]);
    setDeleting(false);

    const okCount = results.filter((result) => result.ok).length;
    const failedCount = results.length - okCount;
    setBranchStatus(
      failedCount > 0
        ? { kind: 'error', text: `删除完成：${okCount} 个成功，${failedCount} 个失败` }
        : { kind: 'success', text: `已删除 ${okCount} 个分支` }
    );
  }

  function refreshCurrentView() {
    if (viewMode === 'branches' && selectedProject) {
      loadBranches(selectedProject);
      return;
    }

    loadGroup(currentGroupPath, false);
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="breadcrumb-wrap">
          <a
            className="root-icon"
            href={groupHref(config.groupPath)}
            title="根目录"
            onClick={(event) => {
              if (shouldUseBrowserNavigation(event)) return;
              event.preventDefault();
              loadGroup(config.groupPath);
            }}
          >
            <FolderGit2 size={18} />
          </a>
          <nav className="breadcrumbs" aria-label="路径">
            {breadcrumbs.map((crumb, index) => {
              const isProjectCrumb =
                viewMode === 'branches' &&
                crumb.path === (selectedProject?.pathWithNamespace || currentProjectPath);
              const isLastGroupCrumb = viewMode === 'group' && index === breadcrumbs.length - 1;
              const href = isProjectCrumb ? projectBranchesHref(crumb.path) : groupHref(crumb.path);

              return (
                <span className="breadcrumb-node" key={crumb.path}>
                  {index > 0 && <span className="breadcrumb-separator">/</span>}
                  <a
                    href={href}
                    className={isLastGroupCrumb || isProjectCrumb ? 'current' : ''}
                    onClick={(event) => {
                      if (shouldUseBrowserNavigation(event)) return;
                      event.preventDefault();
                      if (isProjectCrumb) {
                        if (selectedProject) {
                          openProject(selectedProject);
                        } else {
                          openProjectPath(crumb.path);
                        }
                        return;
                      }
                      loadGroup(crumb.path);
                    }}
                  >
                    {crumb.label}
                  </a>
                </span>
              );
            })}
            {viewMode === 'branches' && (
              <span className="breadcrumb-node">
                <span className="breadcrumb-separator">/</span>
                <span className="breadcrumb-current">Branches</span>
              </span>
            )}
          </nav>
        </div>
        <div className="header-actions">
          <button className="icon-button" type="button" title="刷新" onClick={refreshCurrentView} disabled={booting}>
            <RefreshCw size={17} />
          </button>
          <button
            className="icon-button"
            type="button"
            title="配置"
            onClick={() => {
              setSettingsDraft(config);
              setSettingsOpen(true);
            }}
          >
            <Settings2 size={17} />
          </button>
          <div className="user-menu">
            <button
              className="avatar-button"
              type="button"
              title="账号信息"
              onClick={() => setUserOpen((value) => !value)}
            >
              {initials(user?.name, user?.username)}
            </button>
            {userOpen && (
              <div className="user-popover">
                <div className="user-card-head">
                  <div className="avatar-large">{initials(user?.name, user?.username)}</div>
                  <div>
                    <strong>{user?.name || '未获取账号'}</strong>
                    <span>{user ? `@${user.username}` : '请检查配置'}</span>
                  </div>
                </div>
                {user && (
                  <dl>
                    <div>
                      <dt>ID</dt>
                      <dd>{user.id}</dd>
                    </div>
                    {user.email && (
                      <div>
                        <dt>Email</dt>
                        <dd>{user.email}</dd>
                      </div>
                    )}
                    {user.webUrl && (
                      <div>
                        <dt>Profile</dt>
                        <dd>
                          <a href={user.webUrl} target="_blank" rel="noreferrer">
                            {user.webUrl}
                          </a>
                        </dd>
                      </div>
                    )}
                  </dl>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="content-shell">
        {viewMode === 'group' ? (
          <GroupList
            booting={booting}
            groupContent={groupContent}
            groupSearch={groupSearch}
            groupStatus={groupStatus}
            footerStatus={groupFooterStatus}
            filteredSubgroups={filteredSubgroups}
            filteredProjects={filteredProjects}
            onSearch={setGroupSearch}
            onOpenGroup={loadGroup}
            onOpenProject={openProject}
            onSettings={() => setSettingsOpen(true)}
          />
        ) : (
          <BranchList
            branchSearch={branchSearch}
            branchStatus={branchStatus}
            footerStatus={branchFooterStatus}
            branchTab={branchTab}
            branchTabs={branchTabs}
            filteredBranches={filteredBranches}
            selectedBranchObjects={selectedBranchObjects}
            allVisibleSelected={allVisibleSelected}
            deletableCount={deletableBranches.length}
            onSearch={setBranchSearch}
            onTab={setBranchTab}
            onRefresh={() => loadBranches()}
            onToggleAll={toggleVisibleBranches}
            onToggleBranch={toggleBranch}
            onCopy={copyText}
            onDelete={openDeleteModal}
          />
        )}
      </main>

      {settingsOpen && (
        <SettingsModal
          config={settingsDraft}
          saveStatus={saveStatus}
          onChange={setSettingsDraft}
          onClose={() => setSettingsOpen(false)}
          onSave={saveSettings}
        />
      )}

      {deleteQueue.length > 0 && selectedProject && (
        <DeleteModal
          project={selectedProject}
          branches={deleteQueue}
          confirmText={confirmText}
          deleteResults={deleteResults}
          deleting={deleting}
          onConfirmText={setConfirmText}
          onClose={() => {
            if (!deleting) {
              setDeleteQueue([]);
            }
          }}
          onDelete={runDelete}
        />
      )}

      {toast && <ToastNotice status={toast} />}
    </div>
  );
}

function GroupList({
  booting,
  groupContent,
  groupSearch,
  groupStatus,
  footerStatus,
  filteredSubgroups,
  filteredProjects,
  onSearch,
  onOpenGroup,
  onOpenProject,
  onSettings
}: {
  booting: boolean;
  groupContent: GroupContent | null;
  groupSearch: string;
  groupStatus: StatusState;
  footerStatus: StatusState;
  filteredSubgroups: GitLabGroup[];
  filteredProjects: GitLabProject[];
  onSearch: (value: string) => void;
  onOpenGroup: (path: string) => void;
  onOpenProject: (project: GitLabProject) => void;
  onSettings: () => void;
}) {
  const hasRows = filteredSubgroups.length > 0 || filteredProjects.length > 0;
  const emptyText = groupStatus.kind === 'error' ? groupStatus.text : groupSearch.trim() ? '没有匹配结果' : '暂无仓库';

  return (
    <section className="view-shell">
      <div className="list-toolbar">
        <div className="title-block">
          <h1>{groupContent?.group.name || 'Repositories'}</h1>
          <p>{groupContent?.group.fullPath || 'GitLab'}</p>
        </div>
        <div className="toolbar-actions">
          <SearchField value={groupSearch} onChange={onSearch} placeholder="Filter by name" label="搜索仓库" />
        </div>
      </div>
      <div className="directory-list">
        {groupStatus.kind === 'loading' && <ListLoading text={groupStatus.text} />}

        {filteredSubgroups.map((group) => (
          <a
            className="directory-row"
            href={groupHref(group.fullPath)}
            key={`group-${group.id}`}
            onClick={(event) => {
              if (shouldUseBrowserNavigation(event)) return;
              event.preventDefault();
              onOpenGroup(group.fullPath);
            }}
          >
            <EntityIcon type="group" />
            <div className="directory-main">
              <strong>{group.name}</strong>
              <span>{group.fullPath}</span>
            </div>
            <Badge>Folder</Badge>
            <ChevronRight size={17} />
          </a>
        ))}

        {filteredProjects.map((project) => (
          <a
            className="directory-row"
            href={projectBranchesHref(project.pathWithNamespace)}
            key={`project-${project.id}`}
            onClick={(event) => {
              if (shouldUseBrowserNavigation(event)) return;
              event.preventDefault();
              onOpenProject(project);
            }}
          >
            <EntityIcon type="project" />
            <div className="directory-main">
              <strong>{project.name}</strong>
              <span>{project.pathWithNamespace}</span>
            </div>
            {project.defaultBranch && <Badge tone="blue">{project.defaultBranch}</Badge>}
            <ChevronRight size={17} />
          </a>
        ))}

        {!hasRows && !booting && (
          <div className="empty-wrap">
            <EmptyState text={emptyText} />
            {groupStatus.kind === 'idle' && (
              <button className="primary-button" type="button" onClick={onSettings}>
                <Settings2 size={16} />
                配置
              </button>
            )}
          </div>
        )}
      </div>
      <ViewFooter status={footerStatus} />
    </section>
  );
}

function BranchList({
  branchSearch,
  branchStatus,
  footerStatus,
  branchTab,
  branchTabs,
  filteredBranches,
  selectedBranchObjects,
  allVisibleSelected,
  deletableCount,
  onSearch,
  onTab,
  onRefresh,
  onToggleAll,
  onToggleBranch,
  onCopy,
  onDelete
}: {
  branchSearch: string;
  branchStatus: StatusState;
  footerStatus: StatusState;
  branchTab: BranchTab;
  branchTabs: Array<{ key: BranchTab; label: string; count: number }>;
  filteredBranches: GitLabBranch[];
  selectedBranchObjects: GitLabBranch[];
  allVisibleSelected: boolean;
  deletableCount: number;
  onSearch: (value: string) => void;
  onTab: (tab: BranchTab) => void;
  onRefresh: () => void;
  onToggleAll: (checked: boolean) => void;
  onToggleBranch: (branch: GitLabBranch, checked: boolean) => void;
  onCopy: (text: string) => void;
  onDelete: (branches: GitLabBranch[]) => void;
}) {
  const emptyText = branchSearch.trim() ? '没有匹配结果' : '暂无分支';

  return (
    <section className="view-shell branch-view">
      <div className="branch-tabs-row">
        <div className="tabs">
          {branchTabs.map((tab) => (
            <button
              className={tab.key === branchTab ? 'active' : ''}
              type="button"
              key={tab.key}
              onClick={() => onTab(tab.key)}
            >
              {tab.label}
              <span>{tab.count}</span>
            </button>
          ))}
        </div>
        <div className="toolbar-actions">
          <SearchField value={branchSearch} onChange={onSearch} placeholder="Filter by branch name" label="搜索分支" />
          <button className="ghost-button" type="button" onClick={onRefresh}>
            <RefreshCw size={16} />
            刷新
          </button>
          <button
            className="danger-button"
            type="button"
            disabled={selectedBranchObjects.length === 0}
            onClick={() => onDelete(selectedBranchObjects)}
          >
            <Trash2 size={16} />
            删除已选 {selectedBranchObjects.length || ''}
          </button>
        </div>
      </div>

      <div className="selection-bar">
        <label className="select-all-control">
          <input
            type="checkbox"
            checked={allVisibleSelected}
            disabled={deletableCount === 0}
            onChange={(event) => onToggleAll(event.target.checked)}
          />
          <span>全选当前列表</span>
        </label>
      </div>

      <div className="branch-list">
        {branchStatus.kind === 'loading' && filteredBranches.length === 0 && <ListLoading text={branchStatus.text} />}

        {filteredBranches.map((branch) => (
          <BranchRow
            key={branch.name}
            branch={branch}
            checked={selectedBranchObjects.some((item) => item.name === branch.name)}
            onToggle={(checked) => onToggleBranch(branch, checked)}
            onCopy={() => onCopy(branch.name)}
            onDelete={() => onDelete([branch])}
          />
        ))}
        {filteredBranches.length === 0 && branchStatus.kind !== 'loading' && <EmptyState text={emptyText} />}
      </div>
      <ViewFooter status={footerStatus} />
    </section>
  );
}

function BranchRow({
  branch,
  checked,
  onToggle,
  onCopy,
  onDelete
}: {
  branch: GitLabBranch;
  checked: boolean;
  onToggle: (checked: boolean) => void;
  onCopy: () => void;
  onDelete: () => void;
}) {
  const dateValue = branch.commit?.committedDate || branch.commit?.createdAt;
  const disabled = !canDelete(branch);

  return (
    <div className={`branch-row ${checked ? 'selected' : ''} ${disabled ? 'locked' : ''}`}>
      <label className="row-check">
        <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onToggle(event.target.checked)} />
      </label>
      <div className="branch-main">
        <div className="branch-title">
          {branch.webUrl ? (
            <a className="branch-name branch-name-link" href={branch.webUrl} target="_blank" rel="noreferrer">
              {branch.name}
            </a>
          ) : (
            <span className="branch-name">{branch.name}</span>
          )}
          <button className="copy-button" type="button" title="复制分支名" onClick={onCopy}>
            <Copy size={14} />
          </button>
          {branch.default && <Badge tone="blue">default</Badge>}
          {branch.protected && (
            <Badge>
              <ShieldCheck size={12} />
              protected
            </Badge>
          )}
        </div>
        <div className="commit-line">
          {branch.commit?.webUrl ? (
            <a href={branch.commit.webUrl} target="_blank" rel="noreferrer">
              {branch.commit.shortId}
            </a>
          ) : (
            <span className="commit-hash">{branch.commit?.shortId}</span>
          )}
          <span>·</span>
          <span className="commit-title">{branch.commit?.title || '无提交信息'}</span>
          {dateValue && (
            <>
              <span>·</span>
              <span className="commit-time">{shortDate(dateValue)}</span>
            </>
          )}
        </div>
      </div>
      <button className="row-delete" type="button" title="删除分支" disabled={disabled} onClick={onDelete}>
        <Trash2 size={16} />
      </button>
    </div>
  );
}

function SearchField({
  value,
  onChange,
  placeholder,
  label
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
}) {
  return (
    <div className="search-field">
      <Search className="search-icon" size={15} />
      <input
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
      {value.length > 0 && (
        <button className="search-clear-button" type="button" title="清空搜索" aria-label="清空搜索" onClick={() => onChange('')}>
          <X size={14} />
        </button>
      )}
    </div>
  );
}

function EntityIcon({ type }: { type: 'group' | 'project' }) {
  return <div className={`entity-icon ${type}`}>{type === 'group' ? <Folder size={18} /> : <FileText size={18} />}</div>;
}

function StatusLine({ status, compact = false }: { status: StatusState; compact?: boolean }) {
  return (
    <div className={`status-line ${status.kind} ${compact ? 'compact' : ''}`}>
      {status.kind === 'loading' && <Loader2 className="spin" size={14} />}
      {status.kind === 'success' && <CheckCircle2 size={14} />}
      {status.kind === 'error' && <AlertTriangle size={14} />}
      <span>{status.text}</span>
    </div>
  );
}

function ViewFooter({ status }: { status: StatusState }) {
  return (
    <footer className="view-footer">
      <StatusLine status={status} compact />
      <span className="app-version">gitlab-branch-cleaner v{APP_VERSION}</span>
    </footer>
  );
}

function ToastNotice({ status }: { status: StatusState }) {
  return (
    <div className={`toast-notice ${status.kind}`} role="status" aria-live="polite">
      {status.kind === 'success' ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
      <span>{status.text}</span>
    </div>
  );
}

function SettingsModal({
  config,
  saveStatus,
  onChange,
  onClose,
  onSave
}: {
  config: AppConfig;
  saveStatus: StatusState;
  onChange: (config: AppConfig) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal settings-modal">
        <div className="modal-header">
          <div>
            <h2>配置</h2>
            <p>GitLab API</p>
          </div>
          <button className="icon-button" type="button" title="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="settings-grid">
          <label>
            <span>Base URL</span>
            <input
              value={config.baseUrl}
              onChange={(event) => onChange({ ...config, baseUrl: event.target.value })}
              placeholder="https://git.17zjh.com"
            />
          </label>
          <label>
            <span>PRIVATE-TOKEN</span>
            <input
              type="password"
              value={config.privateToken}
              onChange={(event) => onChange({ ...config, privateToken: event.target.value })}
              placeholder="glpat-..."
            />
          </label>
          <label>
            <span>Group Path</span>
            <input
              value={config.groupPath}
              onChange={(event) => onChange({ ...config, groupPath: event.target.value })}
              placeholder="ivy_love/front-end"
            />
          </label>
        </div>
        <div className="modal-actions">
          <StatusLine status={saveStatus} compact />
          <button className="ghost-button" type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button" type="button" onClick={onSave} disabled={saveStatus.kind === 'loading'}>
            {saveStatus.kind === 'loading' ? <Loader2 className="spin" size={16} /> : <CheckCircle2 size={16} />}
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteModal({
  project,
  branches,
  confirmText,
  deleteResults,
  deleting,
  onConfirmText,
  onClose,
  onDelete
}: {
  project: GitLabProject;
  branches: GitLabBranch[];
  confirmText: string;
  deleteResults: DeleteResult[];
  deleting: boolean;
  onConfirmText: (value: string) => void;
  onClose: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modal-header">
          <div>
            <h2>删除远程分支</h2>
            <p>{project.pathWithNamespace}</p>
          </div>
          <button className="icon-button" type="button" title="关闭" onClick={onClose} disabled={deleting}>
            <X size={18} />
          </button>
        </div>
        <div className="delete-list">
          {branches.map((branch) => (
            <div key={branch.name}>
              <GitBranch size={15} />
              <span>{branch.name}</span>
            </div>
          ))}
        </div>
        <label className="confirm-field">
          <span>输入 DELETE 确认</span>
          <input value={confirmText} disabled={deleting} onChange={(event) => onConfirmText(event.target.value)} />
        </label>
        <div className="modal-actions">
          <button className="ghost-button" type="button" onClick={onClose} disabled={deleting}>
            取消
          </button>
          <button className="danger-button" type="button" disabled={confirmText !== 'DELETE' || deleting} onClick={onDelete}>
            {deleting ? <Loader2 className="spin" size={16} /> : <Trash2 size={16} />}
            {deleting ? '删除中' : '确认删除'}
          </button>
        </div>
        {deleteResults.length > 0 && (
          <div className="result-list">
            {deleteResults.map((result) => (
              <div key={result.branch} className={result.ok ? 'ok' : 'fail'}>
                {result.ok ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
                <span>{result.branch}</span>
                <small>{result.ok ? '已删除' : result.message}</small>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
