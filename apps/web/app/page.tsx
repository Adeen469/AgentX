"use client";

import { useEffect, useMemo, useState } from "react";
import { Logo } from "./components/brand/Logo";
import { Icon } from "./components/ui/Icon";

type AuthUser = { id: string; name: string; email: string; picture?: string; provider: "google" | "github" };
type Repository = { id: number; fullName: string; private: boolean; defaultBranch: string; url: string };
type Issue = { number: number; title: string; body: string | null; html_url: string; state: string };
type Plan = { summary: string; steps: string[]; likelyFiles: string[]; validationCommands: string[]; irreversibleActions: string[] };
type TestResult = { command: string; passed: boolean; stdout: string; stderr: string };

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error || "Request failed.");
  return body;
}

export default function HomePage() {
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
  const [notice, setNotice] = useState("");
  const [activePage, setActivePage] = useState("investigate");
  const [roomCode, setRoomCode] = useState("");
  const [createdRoom, setCreatedRoom] = useState("");
  const [roomMembers, setRoomMembers] = useState<Array<{ userId: string; displayName: string; status: string }>>([]);
  const [roomStatus, setRoomStatus] = useState("");
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [repositoryQuery, setRepositoryQuery] = useState("");
  const [repositoryFilter, setRepositoryFilter] = useState<"all" | "public" | "private">("all");
  const [contextRepository, setContextRepository] = useState<Repository | null>(null);
  const [contextPosition, setContextPosition] = useState({ x: 0, y: 0 });
  const [approvalPolicy, setApprovalPolicy] = useState("always_ask");

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

  useEffect(() => {
    setApprovalPolicy(localStorage.getItem("agentx-approval-policy") || "always_ask");
  }, []);

  useEffect(() => {
    const updatePage = () => setActivePage(window.location.hash.slice(1) || "investigate");
    updatePage();
    window.addEventListener("hashchange", updatePage);
    return () => window.removeEventListener("hashchange", updatePage);
  }, []);

  function navigate(page: string) {
    window.location.hash = page;
    setActivePage(page);
  }

  async function searchRepositories() {
    if (!repositoryQuery.trim()) return;
    setError(""); setBusy("repository-search");
    try {
      const body = await readJson<{ repositories: Repository[] }>(await fetch(`/api/github/search-repositories?q=${encodeURIComponent(repositoryQuery.trim())}`));
      setRepositories(body.repositories);
      setNotice(`${body.repositories.length} GitHub repositories found.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Repository search failed."); }
    finally { setBusy(""); }
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

  async function collaborationCommand(message: Record<string, unknown>) {
    setError("");
    const tokenResponse = await fetch("/api/collaboration/token");
    if (!tokenResponse.ok) {
      setRoomStatus("Sign in before using collaboration.");
      return;
    }
    const { token } = await readJson<{ token: string }>(tokenResponse);
    const connection = socket || new WebSocket(process.env.NEXT_PUBLIC_COLLABORATION_URL || "ws://localhost:8787");
    setSocket(connection);
    const send = () => {
      connection.send(JSON.stringify({ type: "auth", token }));
      connection.send(JSON.stringify(message));
    };
    if (connection.readyState === WebSocket.OPEN) send();
    else connection.onopen = send;
    connection.onmessage = (event) => {
      const result = JSON.parse(event.data) as { type: string; room?: { code: string; ownerId: string; members: Array<{ userId: string; displayName: string; status: string }> }; message?: string };
      if (result.room) {
        setRoomMembers(result.room.members);
        if (result.room.code) setCreatedRoom(result.room.code);
      }
      setRoomStatus(result.type === "error"
        ? `Collaboration error: ${result.message || "Request failed."}`
        : result.message || (result.type === "room.created" ? "Room created. Approve each join request." : "Room updated."));
    };
    connection.onerror = () => setRoomStatus("Could not connect to the collaboration server.");
  }

  async function loadIssues() {
    if (!repository) return;
    setError(""); setNotice(""); setIssueLoading(true);
    try {
      const body = await readJson<{ issues: Issue[] }>(await fetch(`/api/github/issues?repository=${encodeURIComponent(repository)}`));
      setIssues(body.issues);
      setIssueNumber("");
      setNotice(`${body.issues.length} open issue${body.issues.length === 1 ? "" : "s"} loaded from GitHub.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Issue lookup failed.");
    } finally { setIssueLoading(false); }
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
      setNotice(body.fallbackUsed
        ? `Plan created with ${body.provider || "a fallback provider"} after the primary AI provider was unavailable.`
        : `Plan created with ${body.provider || "the configured AI provider"}.`);
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
    const body = await readJson<{ diff: string }>(await fetch(`/api/workspace/diff?workspace=${encodeURIComponent(workspace)}`));
    setDiff(body.diff);
  }

  async function runTests() {
    if (!workspace) return;
    setError(""); setBusy("test");
    try {
      const body = await readJson<TestResult>(await fetch("/api/workspace/test", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace, command: testCommand })
      }));
      setTestResult(body); await loadDiff();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Test execution failed."); }
    finally { setBusy(""); }
  }

  async function requestApproval() {
    if (!workspace || !selectedIssue || !repository || !testResult?.passed || !diff) return;
    setError(""); setBusy("approval");
    try {
      const body = await readJson<{ approvalToken: string }>(await fetch("/api/agent/approval", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "open_pull_request", confirmation: true,
          payload: { workspace, repository, branch: `agentx/issue-${selectedIssue.number}`, base: "main", title: `Fix #${selectedIssue.number}: ${selectedIssue.title}`, body: `Fixes #${selectedIssue.number}\n\n${plan?.summary || "Fix prepared in AgentX."}\n\nTests: ${testCommand} passed.` }
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

  async function logout() { await fetch("/api/auth/logout", { method: "POST" }); setUser(null); }
  const initials = useMemo(() => user?.name.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "GU", [user]);
  const changed = content !== originalContent;

  return (
    <main className="shell">
      <aside className="sidebar">
        <Logo />
        <div className="nav-group">Bug-fix workflow</div>
        <a className={`nav-item ${activePage === "investigate" ? "is-active" : ""}`} href="#investigate"><Icon name="home" /><span className="nav-text">Investigate</span></a>
        <a className={`nav-item ${activePage === "workspace" ? "is-active" : ""}`} href="#workspace"><Icon name="activity" /><span className="nav-text">Workspace</span></a>
        <a className={`nav-item ${activePage === "review" ? "is-active" : ""}`} href="#review"><Icon name="check" /><span className="nav-text">Review & approve</span></a>
        <div className="nav-group">Connections</div>
        <a className={`nav-item ${activePage === "repositories" ? "is-active" : ""}`} href="#repositories"><Icon name="repository" /><span className="nav-text">Repositories</span></a>
        <a className={`nav-item ${activePage === "collaboration" ? "is-active" : ""}`} href="#collaboration"><Icon name="users" /><span className="nav-text">Collaboration</span></a>
        <div className="nav-group">System</div>
        <a className={`nav-item ${activePage === "settings" ? "is-active" : ""}`} href="#settings"><Icon name="settings" /><span className="nav-text">Settings</span></a>
        <div className="sidebar-foot"><div className="user"><span className="avatar">{initials}</span><div className="user-meta">{authLoading ? <strong>Checking session</strong> : user ? <><strong>{user.name}</strong><span>{user.email}</span></> : <strong>Not signed in</strong>}</div>{user && <button className="icon-button" onClick={logout} title="Sign out"><Icon name="logout" /></button>}</div></div>
      </aside>
      <section className="main">
        <header className="topbar"><div className="crumbs"><span>Bug-fix agent</span><span className="sep">/</span><span className="faint">{workspace ? "Workspace" : activePage === "repositories" ? "Repositories" : "Investigate"}</span></div><div className="search"><span><Icon name="search" /></span><input value={activePage === "repositories" ? repositoryQuery : undefined} onChange={activePage === "repositories" ? (event) => setRepositoryQuery(event.target.value) : undefined} onKeyDown={activePage === "repositories" ? (event) => { if (event.key === "Enter") void searchRepositories(); } : undefined} placeholder={activePage === "repositories" ? "Search all GitHub repositories..." : "Search workspace..."} /><button className="search-submit" onClick={() => void searchRepositories()} hidden={activePage !== "repositories"} aria-label="Search repositories"><Icon name="chevron-right" /></button></div>{!authLoading && !user && <a className="button primary" href="/api/auth/google"><Icon name="google" />Sign in</a>}{user && user.provider !== "github" && <a className="button secondary connect-button" href="/api/auth/github"><Icon name="github" />Connect GitHub</a>}{user && <span className="connection-status"><span className="status-dot" />Connected</span>}</header>
        <div className={`content page-shell page-${activePage}`}>
          {activePage === "workspace" && <section className="page-view">
            <div className="content-head"><div><h1>Workspace</h1><p className="subtle">Edit files and run tests inside the isolated repository workspace.</p></div><button className="secondary" onClick={() => navigate("investigate")}>Choose an issue</button></div>
            {!workspace ? <div className="card card-body empty-state"><Icon name="activity" size={28} /><h2>No workspace created</h2><p className="subtle">Select a GitHub issue in Investigate, then create an isolated workspace.</p><button className="primary" onClick={() => navigate("investigate")}>Start investigation</button></div> : <div className="card card-body"><p className="subtle mono">{workspace}</p><p className="notice success">This workspace is isolated on the AgentX issue branch. Use the file editor and sandbox test runner below.</p></div>}
          </section>}
          {activePage === "review" && <section className="page-view">
            <div className="content-head"><div><h1>Review & approve</h1><p className="subtle">Inspect the exact patch and test result before any branch push or pull request.</p></div></div>
            <section className="card"><div className="card-head"><h2>Human approval gate</h2><span className={testResult?.passed ? "success" : "warning"}>{testResult?.passed ? "Tests passed" : "Tests required"}</span></div><pre className="diff-view">{diff || "No patch is available yet. Create a workspace, edit a file, and save it."}</pre><div className="approval-gate"><div><h3>{approvalToken ? "Approval token ready" : "Nothing irreversible has happened"}</h3><p className="subtle">AgentX cannot merge changes. Pull-request creation requires your explicit confirmation after a passing test.</p></div>{approvalToken ? <button className="primary" onClick={() => void openPullRequest()} disabled={busy === "pr"}>{busy === "pr" ? "Opening..." : "Confirm & open pull request"}</button> : <button className="primary" onClick={() => void requestApproval()} disabled={!diff || !testResult?.passed || busy === "approval"}>{busy === "approval" ? "Preparing..." : "Approve reviewed patch"}</button>}</div>{pullRequestUrl && <p className="notice success"><a href={pullRequestUrl} target="_blank" rel="noreferrer">Open pull request on GitHub</a></p>}</section>
          </section>}
          {activePage === "collaboration" && <section className="page-view">
            <div className="content-head"><div><h1>Collaboration</h1><p className="subtle">Live editing rooms are private: a code alone never grants access, and the owner approves every join request.</p></div></div>
            <section className="card card-body collaboration-view"><div className="form-grid"><label>Join room by code<input value={roomCode} maxLength={6} onChange={(event) => setRoomCode(event.target.value.replace(/[^A-Za-z0-9]/g, ""))} placeholder="6-character code" /></label><button className="secondary action-button" onClick={() => void collaborationCommand({ type: "room.join.request", code: roomCode.trim() })} disabled={roomCode.trim().length !== 6}>Request to join</button></div><button className="primary" onClick={() => void collaborationCommand({ type: "room.create" })}>Create collaboration room</button>{createdRoom && <p className="notice success">Owner room code: <strong className="mono">{createdRoom}</strong>. Share it with invitees; approve them below.</p>}{roomStatus && <p className="notice">{roomStatus}</p>}<div className="member-list">{roomMembers.length === 0 ? <p className="subtle">No members or pending requests yet.</p> : roomMembers.map((member) => <div className="member-row" key={member.userId}><span>{member.displayName} · {member.status}</span>{member.status === "pending" && user?.id !== member.userId && <button onClick={() => socket?.send(JSON.stringify({ type: "room.join.approve", code: createdRoom, userId: member.userId }))}>Approve</button>}{member.status === "approved" && user?.id !== member.userId && <button className="secondary" onClick={() => socket?.send(JSON.stringify({ type: "room.member.remove", code: createdRoom, userId: member.userId }))}>Remove</button>}{member.status === "approved" && user?.id === member.userId && createdRoom !== "" && <button className="secondary" onClick={() => socket?.send(JSON.stringify({ type: "room.leave", code: createdRoom }))}>Leave room</button>}</div>)}</div></section>
          </section>}
          {activePage === "settings" && <section className="page-view">
            <div className="content-head"><div><h1>Settings</h1><p className="subtle">Review connection status and local workspace preferences.</p></div></div>
            <section className="card settings-list"><div className="setting-row"><div><strong>Google sign-in</strong><p className="subtle">Used for your AgentX account session.</p></div>{user?.provider === "google" ? <button className="toggle on" onClick={() => void logout()}><span />Connected · Disconnect</button> : <a className="button secondary" href="/api/auth/google"><Icon name="google" />Connect</a>}</div><div className="setting-row"><div><strong>GitHub access</strong><p className="subtle">Required to load repositories, issues, clone workspaces, and open pull requests.</p></div>{user?.provider === "github" ? <button className="toggle on" onClick={() => void logout()}><span />Connected · Disconnect</button> : <a className="button secondary" href="/api/auth/github"><Icon name="github" />Connect</a>}</div><div className="setting-row"><div><strong>Approval policy</strong><p className="subtle">Choose when AgentX may proceed with protected actions.</p></div><select className="setting-select" value={approvalPolicy} onChange={(event) => setPolicy(event.target.value)}><option value="always_approve">Always approve</option><option value="always_ask">Always ask</option><option value="approve_only_these">Approve only these</option></select></div><div className="setting-row"><div><strong>Workspace root</strong><p className="subtle">Isolated workspaces are managed under the server workspace root.</p></div><code>WORKSPACE_ROOT</code></div></section>
          </section>}
          {activePage === "repositories" && <section className="page-view">
            <div className="content-head"><div><h1>Repositories</h1><p className="subtle">Repositories available to the connected GitHub account.</p></div></div>
            <div className="filter-tabs">{(["all", "public", "private"] as const).map((filter) => <button className={repositoryFilter === filter ? "active" : ""} key={filter} onClick={() => setRepositoryFilter(filter)}>{filter[0].toUpperCase() + filter.slice(1)} <span>{repositories.filter((item) => filter === "all" || (filter === "private" ? item.private : !item.private)).length}</span></button>)}</div>
            <section className="card"><div className="list">{visibleRepositories.length === 0 ? <div className="card-body subtle">{user ? "No repositories match this view." : "Sign in with GitHub to load repositories."}</div> : visibleRepositories.map((item) => <div className="list-row repo-row" key={item.id} onContextMenu={(event) => { event.preventDefault(); setContextRepository(item); setContextPosition({ x: Math.min(event.clientX, window.innerWidth - 300), y: Math.min(event.clientY, window.innerHeight - 180) }); }}><button className="repo-link" onClick={() => selectRepository(item)}><span className="avatar"><Icon name="repository" /></span><div className="list-main"><span className="list-title">{item.fullName}</span><span className="faint">{item.private ? "Private" : "Public"} · default branch {item.defaultBranch}</span></div></button><a className="faint" href={item.url} target="_blank" rel="noreferrer">Visit <Icon name="chevron-right" /></a></div>)}</div></section>
            {contextRepository && <div className="context-menu" style={{ left: contextPosition.x, top: contextPosition.y }} role="menu"><strong>{contextRepository.fullName}</strong><button onClick={() => selectRepository(contextRepository)}>Load issues</button><a href={contextRepository.url} target="_blank" rel="noreferrer">Visit this repository</a><button onClick={() => setContextRepository(null)}>Cancel</button></div>}
          </section>}
          <div className="investigate-content">
          <div className="content-head" id="investigate"><div><h1>Investigate a bug</h1><p className="subtle">Read the issue, reproduce it in isolation, make a tested change, and review the patch before GitHub.</p></div></div>
          {!user && <div className="notice" role="alert">Sign in with GitHub to access repositories, issues, and the isolated workspace.</div>}
          {error && <div className="notice error" role="alert">{error}{/github|clone|repository/i.test(error) ? <span className="subtle">Reconnect GitHub from Settings, then retry the workspace.</span> : <span className="subtle">AgentX tries both keys for Groq, Gemini, OpenRouter, and NVIDIA in sequence.</span>}</div>}
          {notice && <div className="notice success">{notice}</div>}
          <section className="card workflow-card">
            <div className="stepper"><span className="step active">1 <b>Issue</b></span><span className={plan ? "step active" : "step"}>2 <b>Plan</b></span><span className={workspace ? "step active" : "step"}>3 <b>Workspace</b></span><span className={diff ? "step active" : "step"}>4 <b>Review</b></span><span className={pullRequestUrl ? "step active" : "step"}>5 <b>Pull request</b></span></div>
            <div className="card-body">
              <div className="form-grid"><label>Repository<select value={repository} onChange={(event) => { setRepository(event.target.value); setIssues([]); }} disabled={!user || busy === "repositories"}><option value="">Select a GitHub repository</option>{visibleRepositories.map((item) => <option key={item.id} value={item.fullName}>{item.fullName} · {item.private ? "Private" : "Public"}</option>)}</select></label><button className="secondary action-button" onClick={() => void loadIssues()} disabled={!repository || issueLoading}>{issueLoading ? "Loading issues..." : "Load issues"}</button></div>
              <label className="issue-select">Issue<select value={issueNumber} onChange={(event) => setIssueNumber(event.target.value)} disabled={!issues.length}><option value="">Select an open issue</option>{issues.map((issue) => <option key={issue.number} value={issue.number}>#{issue.number} — {issue.title}</option>)}</select></label>
              {selectedIssue && <div className="issue-preview"><div><strong>#{selectedIssue.number} {selectedIssue.title}</strong><p className="subtle">{selectedIssue.body || "This issue has no description."}</p></div><a className="button secondary" href={selectedIssue.html_url} target="_blank" rel="noreferrer">View on GitHub</a></div>}
              <div className="action-row"><button className="primary" onClick={() => void createPlan()} disabled={!selectedIssue || busy === "plan"}>{busy === "plan" ? "Planning..." : "Analyze issue"}</button><button className="secondary" onClick={() => void createWorkspace()} disabled={!selectedIssue || busy === "workspace"}>{busy === "workspace" ? "Creating sandbox..." : "Create isolated workspace"}</button></div>
            </div>
          </section>
          {plan && <section className="card section-gap"><div className="card-head"><h2>Agent plan</h2><span className="badge">Human review required</span></div><div className="card-body plan-grid"><div><h3>{plan.summary}</h3><ol>{plan.steps.map((step, index) => <li key={`${index}-${step}`}>{step}</li>)}</ol></div><div><strong>Likely files</strong><ul>{plan.likelyFiles.map((file) => <li key={file} className="mono">{file}</li>)}</ul><strong>Validation</strong><ul>{plan.validationCommands.map((command) => <li key={command} className="mono">{command}</li>)}</ul></div></div></section>}
          {workspace && <section className="workspace-panel section-gap" id="workspace"><aside className="file-panel"><div className="panel-title"><span>Files</span><span className="badge">{files.length}</span></div>{files.map((file) => <button className={file === selectedFile ? "file-item active" : "file-item"} key={file} onClick={() => void openFile(file)}><Icon name="folder" size={14} /><span>{file}</span></button>)}</aside><div className="editor-area"><div className="editor-header"><span className="mono">{selectedFile || "Select a file"}</span><div><button className="secondary small-button" onClick={() => void loadDiff()}>Refresh diff</button><button className="primary small-button" onClick={() => void saveFile()} disabled={!selectedFile || !changed || busy === "save"}>{busy === "save" ? "Saving..." : "Save file"}</button></div></div><textarea className="code-editor" value={content} onChange={(event) => setContent(event.target.value)} placeholder="Select a file from the workspace tree." spellCheck={false} /><div className="terminal"><div className="terminal-title">Sandbox tests</div><div className="test-row"><select value={testCommand} onChange={(event) => setTestCommand(event.target.value)}><option>npm test</option><option>npm run test</option><option>npm run lint</option><option>pytest</option><option>dotnet test</option><option>cargo test</option><option>go test ./...</option></select><button className="primary" onClick={() => void runTests()} disabled={busy === "test"}>{busy === "test" ? "Running..." : "Run test"}</button></div>{testResult && <pre className={testResult.passed ? "test-output passed" : "test-output failed"}>{testResult.stdout || testResult.stderr || "No test output."}</pre>}</div></div></section>}
          {workspace && <section className="card section-gap" id="review"><div className="card-head"><h2>Patch review</h2><span className={diff ? "success" : "faint"}>{diff ? "Changes detected" : "No changes yet"}</span></div><pre className="diff-view">{diff || "Save a file to produce a real git diff."}</pre><div className="approval-gate"><div><span className="gate-label">Approval gate</span><h3>Open a pull request only after you review this patch</h3><p className="subtle">Tests must pass. AgentX cannot merge changes and will not push without your explicit confirmation.</p></div>{!approvalToken ? <button className="primary" onClick={() => void requestApproval()} disabled={!diff || !testResult?.passed || busy === "approval"}>{busy === "approval" ? "Preparing approval..." : "Approve & prepare PR"}</button> : <button className="primary" onClick={() => void openPullRequest()} disabled={busy === "pr"}>{busy === "pr" ? "Opening PR..." : "Confirm & open pull request"}</button>}</div>{pullRequestUrl && <p className="notice success"><a href={pullRequestUrl} target="_blank" rel="noreferrer">Open the pull request on GitHub</a></p>}</section>}
          <section className="card section-gap" id="repositories"><div className="card-head"><h2>Connected repositories</h2><span className="faint">{repositories.length} loaded</span></div><div className="list">{repositories.length === 0 ? <div className="card-body subtle">{user ? "No repositories were returned by GitHub." : "Sign in with GitHub to load repositories."}</div> : repositories.map((item) => <a className="list-row" key={item.id} href={item.url} target="_blank" rel="noreferrer"><span className="avatar"><Icon name="repository" /></span><div className="list-main"><span className="list-title">{item.fullName}</span><span className="faint">{item.private ? "Private" : "Public"} · {item.defaultBranch}</span></div><Icon name="chevron-right" /></a>)}</div></section>
        </div>
        </div>
      </section>
    </main>
  );
}
