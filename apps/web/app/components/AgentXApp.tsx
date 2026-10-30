"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./ui/Icon";

type AuthUser = { id: string; name: string; email: string; picture?: string; provider: "github" };
type Repository = { id: number; fullName: string; private: boolean; defaultBranch: string; url: string };
type Issue = { number: number; title: string; body: string | null; html_url: string; state: string };
type Plan = { summary: string; steps: string[]; likelyFiles: string[]; validationCommands: string[]; irreversibleActions: string[] };
type TestResult = { command: string; passed: boolean; stdout: string; stderr: string; sandboxed?: boolean; image?: string };

const PAGES = ["investigate", "workspace", "review", "repositories", "settings"] as const;
type Page = (typeof PAGES)[number];
const PAGE_PATHS: Record<Page, string> = {
  investigate: "/app",
  workspace: "/app/workspace",
  review: "/app/review",
  repositories: "/app/repositories",
  settings: "/app/settings",
};
const PATH_PAGES: Record<string, Page> = {
  "/app": "investigate",
  "/app/workspace": "workspace",
  "/app/review": "review",
  "/app/repositories": "repositories",
  "/app/settings": "settings",
};

function pageFromPath(pathname: string): Page {
  const clean = pathname.replace(/\/$/, "") || "/app";
  return PATH_PAGES[clean] || "investigate";
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  let body: (T & { error?: string }) | null = null;
  try { body = JSON.parse(text) as T & { error?: string }; } catch { /* non-JSON error page */ }
  if (!response.ok) {
    throw new Error(
      body?.error ||
      (response.status === 503
        ? "Service unavailable. On the Vercel deployment this usually means no Docker sandbox or no AI provider is reachable from serverless — run AgentX locally with Docker for workspaces and tests."
        : `Request failed (${response.status}).`)
    );
  }
  if (!body) throw new Error("Server returned an unexpected response.");
  return body;
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export default function AgentXApp() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [repository, setRepository] = useState("");
  const [issues, setIssues] = useState<Issue[]>([]);
  const [issueNumber, setIssueNumber] = useState("");
  const [issueLoading, setIssueLoading] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [workspace, setWorkspace] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState("");
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [diff, setDiff] = useState("");
  const [testCommand, setTestCommand] = useState("npm test");
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [approvalToken, setApprovalToken] = useState("");
  const [pullRequestUrl, setPullRequestUrl] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [sandboxNotice, setSandboxNotice] = useState("");
  const [notice, setNotice] = useState("");
  const [activePage, setActivePage] = useState<Page>("investigate");
  const [repositoryQuery, setRepositoryQuery] = useState("");
  const [headerQuery, setHeaderQuery] = useState("");
  const [repositoryFilter, setRepositoryFilter] = useState<"all" | "public" | "private">("all");
  const [contextRepository, setContextRepository] = useState<Repository | null>(null);
  const [contextPosition, setContextPosition] = useState({ x: 0, y: 0 });
  const [approvalPolicy, setApprovalPolicy] = useState("always_ask");
  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    fetch("/api/auth/session")
      .then((response) => response.json())
      .then((session: { user: AuthUser | null }) => setUser(session.user))
      .catch(() => setUser(null))
      .finally(() => setAuthLoading(false));
  }, []);

  useEffect(() => {
    if (!user) return;
    if (user.provider !== "github") return;
    setBusy("repositories");
    fetch("/api/github/repositories")
      .then((response) => readJson<{ repositories: Repository[] }>(response))
      .then((body) => setRepositories(body.repositories))
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setBusy(""));
  }, [user]);

  useEffect(() => { setApprovalPolicy(localStorage.getItem("agentx-approval-policy") || "always_ask"); }, []);

  // Real paths, not hash fragments. Each /app/* path is a real route
  // rendering this shell, so a refresh or a direct link never 404s;
  // in-app navigation is a pushState, so the workflow state in this
  // component is not remounted away. No middleware: Vercel services
  // do not support Edge middleware, and it failed deployments.
  useEffect(() => {
    const sync = () => setActivePage(pageFromPath(window.location.pathname));
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  // GitHub-style: pressing / focuses the header search, unless typing already.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key !== "/" || !searchInputRef.current) return;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) return;
      event.preventDefault();
      searchInputRef.current.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Remember only the safe, refetchable choices across a refresh. A workspace
  // path is deliberately not restored: on Vercel it is ephemeral, and a stale
  // path would fail every file/diff call with a confusing error.
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem("agentx-workflow") || "null") as { repository?: string; issueNumber?: string } | null;
      if (saved?.repository) setRepository(saved.repository);
      if (saved?.issueNumber) setIssueNumber(saved.issueNumber);
    } catch { /* ignore corrupt saved state */ }
  }, []);
  useEffect(() => {
    try { sessionStorage.setItem("agentx-workflow", JSON.stringify({ repository, issueNumber })); } catch { /* private mode */ }
  }, [repository, issueNumber]);

  function navigate(page: Page) {
    window.history.pushState(null, "", PAGE_PATHS[page]);
    setActivePage(page);
    setSidebarOpen(false);
  }
  function toggleSidebar() {
    // Desktop: collapse to icons. Mobile (drawer): open/close the drawer.
    if (typeof window !== "undefined" && window.innerWidth <= 900) setSidebarOpen((open) => !open);
    else setSidebarCollapsed((collapsed) => !collapsed);
  }
  function navLink(page: Page) {
    return {
      href: PAGE_PATHS[page],
      onClick: (event: React.MouseEvent) => { event.preventDefault(); navigate(page); },
    };
  }

  async function searchRepositories(query?: string) {
    const q = (query ?? repositoryQuery).trim();
    if (!q) return;
    setError(""); setBusy("repository-search");
    try {
      const body = await readJson<{ repositories: Repository[] }>(await fetch(`/api/github/search-repositories?q=${encodeURIComponent(q)}`));
      setRepositories(body.repositories);
      setNotice(`${body.repositories.length} GitHub repositories found.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Repository search failed."); }
    finally { setBusy(""); }
  }
  function headerSearch() {
    if (!headerQuery.trim()) return;
    setRepositoryQuery(headerQuery);
    navigate("repositories");
    void searchRepositories(headerQuery);
  }

  function setPolicy(value: string) {
    setApprovalPolicy(value);
    localStorage.setItem("agentx-approval-policy", value);
    setNotice("Approval policy saved on this device.");
  }

  function selectRepository(item: Repository) {
    setRepository(item.fullName);
    setContextRepository(null);
    navigate("investigate");
    setNotice(`${item.fullName} selected. Load its open issues to continue.`);
  }

  const visibleRepositories = repositories.filter((item) => repositoryFilter === "all" || (repositoryFilter === "private" ? item.private : !item.private));

  async function loadIssues() {
    if (!repository) return;
    setError(""); setNotice(""); setIssueLoading(true);
    try {
      const body = await readJson<{ issues: Issue[] }>(await fetch(`/api/github/issues?repository=${encodeURIComponent(repository)}`));
      setIssues(body.issues); setIssueNumber("");
      setNotice(`${body.issues.length} open issue${body.issues.length === 1 ? "" : "s"} loaded from GitHub.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Issue lookup failed."); }
    finally { setIssueLoading(false); }
  }

  const selectedIssue = issues.find((issue) => String(issue.number) === issueNumber);

  async function createPlan() {
    if (!selectedIssue || !repository) return;
    setError(""); setBusy("plan");
    try {
      const body = await readJson<{ plan: Plan; provider?: string; fallbackUsed?: boolean }>(await fetch("/api/agent/plan", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ repository, issueTitle: selectedIssue.title, issueBody: selectedIssue.body })
      }));
      setPlan(body.plan);
      setNotice(body.fallbackUsed ? `Plan created with ${body.provider || "a fallback provider"} after the primary AI provider was unavailable.` : `Plan created with ${body.provider || "the configured AI provider"}.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Planning failed."); }
    finally { setBusy(""); }
  }

  async function createWorkspace() {
    if (!selectedIssue || !repository) return;
    setError(""); setBusy("workspace");
    try {
      const body = await readJson<{ workspace: string }>(await fetch("/api/workspace/create", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ repository, issueNumber: selectedIssue.number })
      }));
      setWorkspace(body.workspace);
      const filesBody = await readJson<{ files: string[] }>(await fetch(`/api/workspace/files?workspace=${encodeURIComponent(body.workspace)}`));
      setFiles(filesBody.files);
      setNotice("Isolated workspace created on an agent branch. Review before editing.");
      navigate("workspace");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Workspace creation failed."); }
    finally { setBusy(""); }
  }

  async function openFile(filePath: string) {
    setError(""); setBusy("file");
    try {
      const body = await readJson<{ content: string }>(await fetch(`/api/workspace/file?workspace=${encodeURIComponent(workspace)}&path=${encodeURIComponent(filePath)}`));
      setSelectedFile(filePath); setContent(body.content); setOriginalContent(body.content);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "File read failed."); }
    finally { setBusy(""); }
  }

  async function saveFile() {
    if (!workspace || !selectedFile) return;
    setError(""); setBusy("save");
    try {
      await readJson<{ ok: true }>(await fetch("/api/workspace/file", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace, path: selectedFile, content })
      }));
      setOriginalContent(content); setNotice(`Saved ${selectedFile}.`);
      await loadDiff();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "File save failed."); }
    finally { setBusy(""); }
  }

  async function loadDiff() {
    if (!workspace) return;
    try {
      const body = await readJson<{ diff: string }>(await fetch(`/api/workspace/diff?workspace=${encodeURIComponent(workspace)}`));
      setDiff(body.diff);
    } catch { setDiff(""); }
  }

  async function runTests() {
    if (!workspace) return;
    setError(""); setSandboxNotice(""); setBusy("test");
    try {
      const body = await readJson<TestResult>(await fetch("/api/workspace/test", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace, command: testCommand })
      }));
      setTestResult(body); await loadDiff();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Test execution failed.";
      if (/docker|sandbox/i.test(message)) {
        setSandboxNotice("Sandbox unavailable here: tests need a Docker daemon, which the Vercel deployment does not have. Run AgentX locally with Docker installed to run tests — nothing is run on the host as a fallback.");
        setTestResult(null);
      } else setError(message);
    } finally { setBusy(""); }
  }

  async function requestApproval() {
    if (!workspace || !selectedIssue || !repository || !testResult?.passed || !diff) return;
    setError(""); setBusy("approval");
    try {
      const body = await readJson<{ approvalToken: string }>(await fetch("/api/agent/approval", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "open_pull_request", confirmation: true,
          payload: { workspace, repository, branch: `agentx/issue-${selectedIssue.number}`, base: "main", title: `Fix #${selectedIssue.number}: ${selectedIssue.title}`, body: `Fixes #${selectedIssue.number}\n\n${plan?.summary || "Fix prepared in AgentX."}\n\nTests: ${testCommand} passed.`, testPassed: testResult.passed, diff, testCommand }
        })
      }));
      setApprovalToken(body.approvalToken);
      setNotice("Approval token created. The final action is still waiting for your confirmation.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Approval request failed."); }
    finally { setBusy(""); }
  }

  async function openPullRequest() {
    if (!approvalToken) return;
    setError(""); setBusy("pr");
    try {
      const body = await readJson<{ pullRequest: { html_url: string } }>(await fetch("/api/github/pull-request", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ approvalToken })
      }));
      setPullRequestUrl(body.pullRequest.html_url);
      setNotice("Pull request opened successfully. Merge remains under GitHub review.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Pull request creation failed."); }
    finally { setBusy(""); }
  }

  async function logout() { await fetch("/api/auth/logout", { method: "POST" }); setUser(null); setAvatarMenuOpen(false); }
  const initials = useMemo(() => user?.name.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "GU", [user]);
  const changed = content !== originalContent;
  const errorHint = /docker|sandbox/i.test(error)
    ? "Sandbox unavailable on this deployment — run AgentX locally with Docker for tests."
    : /github|clone|repository/i.test(error)
    ? "Reconnect GitHub from Settings, then retry."
    : /provider|AI/i.test(error)
    ? "AgentX tries Groq, Gemini, OpenRouter, and NVIDIA in sequence — check that at least one key is set."
    : "";

  const navItems: Array<{ page: Page; label: string; icon: "home" | "activity" | "check" | "repository" | "users" | "settings" }> = [
    { page: "investigate", label: "Investigate", icon: "home" },
    { page: "workspace", label: "Workspace", icon: "activity" },
    { page: "review", label: "Review & approve", icon: "check" },
    { page: "repositories", label: "Repositories", icon: "repository" },
    { page: "settings", label: "Settings", icon: "settings" },
  ];

  return (
    <div className="app">
      <header className="gh-header">
        <button className="gh-icon-btn" onClick={toggleSidebar} title="Toggle sidebar" aria-label="Toggle sidebar"><Icon name="menu" /></button>
        <a className="gh-brand" href="/"><Icon name="github" size={32} />AgentX</a>
        <div className="gh-search">
          <span className="search-icon"><Icon name="search" size={16} /></span>
          <input ref={searchInputRef} value={headerQuery} onChange={(event) => setHeaderQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") headerSearch(); }} placeholder="Type / to search" aria-label="Search repositories" />
          <kbd>/</kbd>
        </div>
        <div className="gh-header-actions">
          <a className="gh-icon-btn" {...navLink("repositories")} title="New" aria-label="Repositories"><Icon name="repository" /></a>
          <a className="gh-icon-btn" href="https://github.com/issues" target="_blank" rel="noreferrer" title="Issues" aria-label="GitHub issues"><Icon name="issues" /></a>
          <a className="gh-icon-btn" href="https://github.com/pulls" target="_blank" rel="noreferrer" title="Pull requests" aria-label="GitHub pull requests"><Icon name="git-branch" /></a>
          {!authLoading && !user && <a className="button primary" href="/api/auth/github"><Icon name="github" />Sign in with GitHub</a>}
          {user && <span className="connection-status"><span className="status-dot" />Connected</span>}
          {user && (
            <div className="gh-avatar-btn">
              <button className="gh-avatar-btn" onClick={() => setAvatarMenuOpen((open) => !open)} aria-label="Account menu">
                {user.picture ? <img className="gh-avatar" src={user.picture} alt="" /> : <span className="avatar">{initials}</span>}
              </button>
              {avatarMenuOpen && (
                <div className="gh-menu">
                  <a {...navLink("settings")} onClick={(event) => { event.preventDefault(); setAvatarMenuOpen(false); navigate("settings"); }}>Settings</a>
                  <button onClick={() => void logout()}>Sign out</button>
                </div>
              )}
            </div>
          )}
        </div>
      </header>

      <div className={`shell${sidebarCollapsed ? " sidebar-collapsed" : ""}${sidebarOpen ? " sidebar-open" : ""}`}>
        <aside className="sidebar">
          <div className="sidebar-nav">
          <div className="nav-group">Bug-fix workflow</div>
          {navItems.slice(0, 3).map((item) => (
            <a key={item.page} className={`nav-item ${activePage === item.page ? "is-active" : ""}`} {...navLink(item.page)}><Icon name={item.icon} /><span>{item.label}</span></a>
          ))}
          <div className="nav-group">Connections</div>
          {navItems.slice(3, 5).map((item) => (
            <a key={item.page} className={`nav-item ${activePage === item.page ? "is-active" : ""}`} {...navLink(item.page)}><Icon name={item.icon} /><span>{item.label}</span></a>
          ))}
          <div className="nav-group">System</div>
          <a className={`nav-item ${activePage === "settings" ? "is-active" : ""}`} {...navLink("settings")}><Icon name="settings" /><span>Settings</span></a>
          <div className="nav-group">Top repositories</div>
          <div className="top-repos">
            {repositories.slice(0, 8).map((item) => (
              <button key={item.id} className="top-repo" onClick={() => selectRepository(item)}>
                <span className="repo-avatar">{item.fullName.split("/")[0]?.[0]?.toUpperCase() || "R"}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.fullName}</span>
              </button>
            ))}
            {user && repositories.length === 0 && <p className="faint">No repositories loaded yet.</p>}
            {!user && <p className="faint">Sign in to see your repositories.</p>}
          </div>
          {repositories.length > 8 && <a className="nav-item" {...navLink("repositories")}>Show more</a>}
          </div>
          <div className="sidebar-foot">
            <div className="user">
              {user?.picture ? <img className="gh-avatar" src={user.picture} alt="" /> : <span className="avatar">{initials}</span>}
              <div className="user-meta">
                {authLoading ? <strong>Checking session</strong> : user ? <><strong>{user.name}</strong><span>{user.email}</span></> : <strong>Not signed in</strong>}
              </div>
              {user && <button className="icon-button" onClick={() => void logout()} title="Sign out"><Icon name="logout" /></button>}
            </div>
          </div>
        </aside>
        {sidebarOpen && <button className="sidebar-overlay" onClick={() => setSidebarOpen(false)} aria-label="Close sidebar" />}

        <section className="main">
          <div className="content">
            {error && <div className="flash flash-error" role="alert">{error}{errorHint && <span className="subtle"> {errorHint}</span>}</div>}
            {sandboxNotice && <div className="flash flash-warn" role="alert">{sandboxNotice}</div>}
            {notice && <div className="flash flash-success">{notice}</div>}

            {activePage === "investigate" && (
              <section className="page-view">
                <div className="content-head">
                  <div>
                    <h1>{user ? `${greeting()}, ${user.name.split(" ")[0]}!` : "Investigate a bug"}</h1>
                    <p className="subtle">Read the issue, reproduce it in isolation, make a tested change, and review the patch before GitHub.</p>
                  </div>
                </div>
                <div className="stats-grid">
                  <div className="stat-card"><strong>{repositories.length}</strong><span>Repositories loaded</span></div>
                  <div className="stat-card"><strong>{issues.length}</strong><span>Open issues loaded</span></div>
                  <div className="stat-card"><strong>{workspace ? "Ready" : "None"}</strong><span>Workspace</span></div>
                  <div className="stat-card"><strong>{testResult ? (testResult.passed ? "Passed" : "Failed") : "Not run"}</strong><span>Last sandbox test</span></div>
                </div>
                {!user && <div className="flash">Sign in with GitHub to access repositories, issues, and the isolated workspace.</div>}
                <section className="card workflow-card">
                  <div className="stepper">
                    <span className="step active">1 <b>Issue</b></span>
                    <span className={plan ? "step active" : "step"}>2 <b>Plan</b></span>
                    <span className={workspace ? "step active" : "step"}>3 <b>Workspace</b></span>
                    <span className={diff ? "step active" : "step"}>4 <b>Review</b></span>
                    <span className={pullRequestUrl ? "step active" : "step"}>5 <b>Pull request</b></span>
                  </div>
                  <div className="card-body">
                    <div className="form-grid">
                      <label>Repository
                        <select value={repository} onChange={(event) => { setRepository(event.target.value); setIssues([]); }} disabled={!user || busy === "repositories"}>
                          <option value="">Select a GitHub repository</option>
                          {visibleRepositories.map((item) => <option key={item.id} value={item.fullName}>{item.fullName} · {item.private ? "Private" : "Public"}</option>)}
                        </select>
                      </label>
                      <button className="secondary action-button" onClick={() => void loadIssues()} disabled={!repository || issueLoading}>{issueLoading ? "Loading issues..." : "Load issues"}</button>
                    </div>
                    <label className="issue-select">Issue
                      <select value={issueNumber} onChange={(event) => setIssueNumber(event.target.value)} disabled={!issues.length}>
                        <option value="">Select an open issue</option>
                        {issues.map((issue) => <option key={issue.number} value={issue.number}>#{issue.number} — {issue.title}</option>)}
                      </select>
                    </label>
                    {selectedIssue && (
                      <div className="issue-preview">
                        <div><strong>#{selectedIssue.number} {selectedIssue.title}</strong><p className="subtle">{selectedIssue.body || "This issue has no description."}</p></div>
                        <a className="button secondary" href={selectedIssue.html_url} target="_blank" rel="noreferrer">View on GitHub</a>
                      </div>
                    )}
                    <div className="action-row">
                      <button className="primary" onClick={() => void createPlan()} disabled={!selectedIssue || busy === "plan"}>{busy === "plan" ? "Planning..." : "Analyze issue"}</button>
                      <button className="secondary" onClick={() => void createWorkspace()} disabled={!selectedIssue || busy === "workspace"}>{busy === "workspace" ? "Creating workspace..." : "Create isolated workspace"}</button>
                    </div>
                  </div>
                </section>
                {plan && (
                  <section className="card section-gap">
                    <div className="card-head"><h2>Agent plan</h2><span className="badge">Human review required</span></div>
                    <div className="card-body plan-grid">
                      <div><h3>{plan.summary}</h3><ol>{plan.steps.map((step, index) => <li key={`${index}-${step}`}>{step}</li>)}</ol></div>
                      <div><strong>Likely files</strong><ul>{plan.likelyFiles.map((file) => <li key={file} className="mono">{file}</li>)}</ul><strong>Validation</strong><ul>{plan.validationCommands.map((command) => <li key={command} className="mono">{command}</li>)}</ul></div>
                    </div>
                  </section>
                )}
              </section>
            )}

            {activePage === "workspace" && (
              <section className="page-view">
                <div className="content-head"><div><h1>Workspace</h1><p className="subtle">Edit files and run tests inside the isolated repository workspace.</p></div><button className="secondary" onClick={() => navigate("investigate")}>Choose an issue</button></div>
                {!workspace ? (
                  <div className="card card-body empty-state"><Icon name="activity" size={28} /><h2>No workspace created</h2><p className="subtle">Select a GitHub issue in Investigate, then create an isolated workspace.</p><button className="primary" onClick={() => navigate("investigate")}>Start investigation</button></div>
                ) : (
                  <section className="workspace-panel">
                    <aside className="file-panel">
                      <div className="panel-title"><span>Files</span><span className="badge">{files.length}</span></div>
                      {files.map((file) => <button className={file === selectedFile ? "file-item active" : "file-item"} key={file} onClick={() => void openFile(file)}><Icon name="folder" size={14} /><span>{file}</span></button>)}
                    </aside>
                    <div className="editor-area">
                      <div className="editor-header"><span className="mono">{selectedFile || "Select a file"}</span><div><button className="secondary small-button" onClick={() => void loadDiff()}>Refresh diff</button><button className="primary small-button" onClick={() => void saveFile()} disabled={!selectedFile || !changed || busy === "save"}>{busy === "save" ? "Saving..." : "Save file"}</button></div></div>
                      <textarea className="code-editor" value={content} onChange={(event) => setContent(event.target.value)} placeholder="Select a file from the workspace tree." spellCheck={false} />
                      <div className="terminal">
                        <div className="terminal-title">Sandbox tests</div>
                        <div className="test-row">
                          <select value={testCommand} onChange={(event) => setTestCommand(event.target.value)}><option>npm test</option><option>npm run test</option><option>npm run lint</option><option>pytest</option><option>dotnet test</option><option>cargo test</option><option>go test ./...</option></select>
                          <button className="primary" onClick={() => void runTests()} disabled={busy === "test"}>{busy === "test" ? "Running..." : "Run test"}</button>
                        </div>
                        {testResult && (<>
                          {testResult.sandboxed && <p className="subtle mono">Docker sandbox · {testResult.image || "unknown image"} · network off · host files not mounted</p>}
                          <pre className={testResult.passed ? "test-output passed" : "test-output failed"}>{testResult.stdout || testResult.stderr || "No test output."}</pre>
                        </>)}
                      </div>
                    </div>
                  </section>
                )}
              </section>
            )}

            {activePage === "review" && (
              <section className="page-view">
                <div className="content-head"><div><h1>Review & approve</h1><p className="subtle">Inspect the exact patch and test result before any branch push or pull request.</p></div></div>
                <section className="card">
                  <div className="card-head"><h2>Human approval gate</h2><span className={testResult?.passed ? "success" : "warning"}>{testResult?.passed ? "Tests passed" : "Tests required"}</span></div>
                  <pre className="diff-view">{diff || "No patch is available yet. Create a workspace, edit a file, and save it."}</pre>
                  <div className="approval-gate">
                    <div><h3>{approvalToken ? "Approval token ready" : "Nothing irreversible has happened"}</h3><p className="subtle">AgentX cannot merge changes. Pull-request creation requires your explicit confirmation after a passing test.</p></div>
                    {approvalToken ? <button className="primary" onClick={() => void openPullRequest()} disabled={busy === "pr"}>{busy === "pr" ? "Opening..." : "Confirm & open pull request"}</button> : <button className="primary" onClick={() => void requestApproval()} disabled={!diff || !testResult?.passed || busy === "approval"}>{busy === "approval" ? "Preparing..." : "Approve reviewed patch"}</button>}
                  </div>
                  {pullRequestUrl && <p className="flash flash-success"><a href={pullRequestUrl} target="_blank" rel="noreferrer">Open pull request on GitHub</a></p>}
                </section>
              </section>
            )}

            {activePage === "settings" && (
              <section className="page-view">
                <div className="content-head"><div><h1>Settings</h1><p className="subtle">Review connection status and local workspace preferences.</p></div></div>
                <section className="card settings-list">
                  <div className="setting-row"><div><strong>GitHub sign-in</strong><p className="subtle">Used for your AgentX account session, and required to load repositories, issues, clone workspaces, and open pull requests.</p></div>{user?.provider === "github" ? <button className="toggle on" onClick={() => void logout()}><span />Connected · Disconnect</button> : <a className="button secondary" href="/api/auth/github"><Icon name="github" />Connect</a>}</div>
                  <div className="setting-row"><div><strong>Approval policy</strong><p className="subtle">Choose when AgentX may proceed with protected actions.</p></div><select className="setting-select" value={approvalPolicy} onChange={(event) => setPolicy(event.target.value)}><option value="always_approve">Always approve</option><option value="always_ask">Always ask</option><option value="approve_only_these">Approve only these</option></select></div>
                  <div className="setting-row"><div><strong>Workspace root</strong><p className="subtle">Isolated workspaces are managed under the server workspace root. On the Vercel deployment this is ephemeral — workspaces and sandbox tests need a local run with git and Docker.</p></div><code>WORKSPACE_ROOT</code></div>
                </section>
              </section>
            )}

            {activePage === "repositories" && (
              <section className="page-view">
                <div className="content-head"><div><h1>Repositories</h1><p className="subtle">Repositories available to the connected GitHub account.</p></div></div>
                <div className="form-grid" style={{ marginBottom: 16 }}>
                  <label>Search GitHub repositories<input value={repositoryQuery} onChange={(event) => setRepositoryQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void searchRepositories(); }} placeholder="Search all GitHub repositories..." /></label>
                  <button className="secondary action-button" onClick={() => void searchRepositories()} disabled={busy === "repository-search"}>{busy === "repository-search" ? "Searching..." : "Search"}</button>
                </div>
                <div className="filter-tabs">{(["all", "public", "private"] as const).map((filter) => <button className={repositoryFilter === filter ? "active" : ""} key={filter} onClick={() => setRepositoryFilter(filter)}>{filter[0].toUpperCase() + filter.slice(1)} <span>{repositories.filter((item) => filter === "all" || (filter === "private" ? item.private : !item.private)).length}</span></button>)}</div>
                <section className="card"><div className="list">
                  {visibleRepositories.length === 0 ? <div className="card-body subtle">{user ? "No repositories match this view." : "Sign in with GitHub to load repositories."}</div> : visibleRepositories.map((item) => (
                    <div className="list-row repo-row" key={item.id} onContextMenu={(event) => { event.preventDefault(); setContextRepository(item); setContextPosition({ x: Math.min(event.clientX, window.innerWidth - 300), y: Math.min(event.clientY, window.innerHeight - 180) }); }}>
                      <button className="repo-link" onClick={() => selectRepository(item)}><span className="avatar"><Icon name="repository" /></span><div className="list-main"><span className="list-title">{item.fullName}</span><span className="faint">{item.private ? "Private" : "Public"} · default branch {item.defaultBranch}</span></div></button>
                      <a className="faint" href={item.url} target="_blank" rel="noreferrer">Visit <Icon name="chevron-right" /></a>
                    </div>
                  ))}
                </div></section>
                {contextRepository && <div className="context-menu" style={{ left: contextPosition.x, top: contextPosition.y }} role="menu"><strong>{contextRepository.fullName}</strong><button onClick={() => selectRepository(contextRepository)}>Load issues</button><a href={contextRepository.url} target="_blank" rel="noreferrer">Visit this repository</a><button onClick={() => setContextRepository(null)}>Cancel</button></div>}
              </section>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
