# GitLab Branch Cleaner

本地运行的 GitLab 远程分支清理工具。页面中配置 GitLab Base URL、`PRIVATE-TOKEN` 和 group path 后，可以通过 GitLab API 拉取仓库、查看远程分支、批量选择并删除分支。

## 使用

```bash
npm install
npm run build
npm start
npm run status
npm run pause
```

默认访问：

```text
http://127.0.0.1:4178
```

`npm start` 会在后台启动服务，重复执行会显示当前进程和访问地址。`npm run pause` 会暂停后台服务，`npm run stop` 是同一个停止动作的别名。

查看当前版本：

```bash
gitlab-branch-cleaner --version
```

和 `lan-material-hub` 一样，后台启动时会检查 npm latest 版本；如果发现新版本，会在启动输出后提示执行 `npm install -g gitlab-branch-cleaner@latest` 更新。网络失败或超时不会影响本地启动。

开发模式：

```bash
npm run dev
```

如果需要前台运行服务：

```bash
npm run serve
```

也可以指定端口并自动打开浏览器：

```bash
npm start -- --port 4180 --open
```

后台启动的 PID 和日志默认保存在：

```text
~/.gitlab-branch-cleaner/gitlab-branch-cleaner.pid
~/.gitlab-branch-cleaner/gitlab-branch-cleaner.log
```

可以通过环境变量改位置：

```bash
GITLAB_BRANCH_CLEANER_HOME=/tmp/gitlab-branch-cleaner npm start
GITLAB_BRANCH_CLEANER_LOG_FILE=/tmp/gitlab-branch-cleaner.log npm start
GITLAB_BRANCH_CLEANER_UPDATE_CHECK_TIMEOUT=800 npm start
```

## 配置

页面配置通过右上角按钮打开弹窗维护。配置会保存在用户目录，升级或重装 npm 包不会重置：

```text
~/.config/gitlab-branch-cleaner/config.json
```

字段：

- `Base URL`：例如 `https://git.17zjh.com`
- `PRIVATE-TOKEN`：GitLab Personal Access Token
- `Group Path`：例如 `ivy_love/front-end`

项目列表使用 GitLab API，并处理分页：

```text
/api/v4/groups/:groupPath/subgroups?per_page=100&page=:page
/api/v4/groups/:groupPath/projects?include_subgroups=false&per_page=100&page=:page
```

右上角用户信息通过 `GET /api/v4/user` 获取。页面不再请求头像图片，只展示姓名或账号首字母；点击后可查看当前 token 对应的姓名、账号、ID 等信息。

仓库列表区分文件夹和仓库文件。仓库列表过滤只匹配行名称，不匹配 path 或完整路径；分支过滤匹配完整分支名。搜索框可一键清空，切换目录或仓库页面后会重置搜索内容。

页面底部展示当前列表统计和 npm 包版本号。

分支列表中的时间只展示相对时间，例如分钟、小时、天、周、月、年，不展示具体日期。分支名可点击打开 GitLab 分支主页；复制分支名后页面顶部会出现提示。

## 页面链接

页面路径会和 GitLab 仓库路径保持一致，方便直接访问二级、三级页面：

```text
/:groupPath
/:projectPath/-/branches
```

例如：

```text
http://127.0.0.1:4178/ivy_love/front-end
http://127.0.0.1:4178/ivy_love/front-end/ivy-admin/-/branches
```

## 删除规则

- 默认分支不会进入可删除选择。
- 受保护分支不会进入可删除选择。
- 删除前需要在确认弹窗输入 `DELETE`。
- 删除请求使用 GitLab API：`DELETE /api/v4/projects/:id/repository/branches/:branch`。
