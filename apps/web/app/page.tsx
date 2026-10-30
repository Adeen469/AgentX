import HashRedirect from "./components/HashRedirect";
import { Icon } from "./components/ui/Icon";

type RepoData = {
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  updated_at: string;
};
type CommitData = {
  sha: string;
  html_url: string;
  commit: { message: string; author: { name: string; date: string } };
};

// Every number on this page comes from the public AgentX repository on
// GitHub, fetched live. If GitHub is unreachable, the numbers are hidden —
// never invented, never sample data.
async function getLiveData(): Promise<{ repo: RepoData | null; commits: CommitData[] }> {
  try {
    const headers = { "User-Agent": "AgentX", Accept: "application/vnd.github+json" };
    const [repoRes, commitRes] = await Promise.all([
      fetch("https://api.github.com/repos/Adeen469/AgentX", { headers, next: { revalidate: 3600 } }),
      fetch("https://api.github.com/repos/Adeen469/AgentX/commits?per_page=5", { headers, next: { revalidate: 3600 } }),
    ]);
    if (!repoRes.ok) return { repo: null, commits: [] };
    const repo = (await repoRes.json()) as RepoData;
    const commits = commitRes.ok ? ((await commitRes.json()) as CommitData[]) : [];
    return { repo, commits };
  } catch {
    return { repo: null, commits: [] };
  }
}

function formatDate(value: string): string {
  try {
    return new Date(value).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return value;
  }
}

export default async function LandingPage() {
  const { repo, commits } = await getLiveData();
  const features = [
    { icon: "issues" as const, title: "Reads the real issue", text: "Loads open issues from the repository you choose on GitHub — title, body, and number — not a pasted description." },
    { icon: "activity" as const, title: "Plans before it touches code", text: "An AI plan with steps, likely files, and validation commands, trying Groq, Gemini, OpenRouter, and NVIDIA in sequence if one fails." },
    { icon: "repository" as const, title: "Isolated workspace", text: "Clones the repo onto an agentx/issue-<number> branch, so the main branch is never edited directly." },
    { icon: "check" as const, title: "Docker sandbox, network off", text: "Tests run in a disposable container with --network none, dropped capabilities, and a read-only root. No host fallback, ever." },
    { icon: "users" as const, title: "Human approval gate", text: "A pull request needs a passing test, a non-empty patch, and your explicit confirmation. AgentX never merges." },
    { icon: "git-branch" as const, title: "PR with an explanation", text: "The pull request links the issue, states the fix, and records the test command that passed." },
  ];
  const steps = [
    { n: "1", title: "Issue", text: "Pick a repository and an open issue." },
    { n: "2", title: "Plan", text: "Review the AI investigation plan." },
    { n: "3", title: "Workspace", text: "Create an isolated branch workspace." },
    { n: "4", title: "Review", text: "Edit, test in the sandbox, read the diff." },
    { n: "5", title: "Pull request", text: "Approve, then open the PR on GitHub." },
  ];

  return (
    <div className="landing">
      <HashRedirect />
      <header className="landing-header">
        <a className="landing-brand" href="/"><Icon name="github" size={28} />AgentX</a>
        <nav className="landing-nav">
          <a href="#features">Features</a>
          <a href="#workflow">Workflow</a>
          <a href="#activity">Activity</a>
          <a href="https://github.com/Adeen469/AgentX" target="_blank" rel="noreferrer">Source</a>
        </nav>
        <div className="landing-actions">
          <a className="button secondary" href="/app">Open app</a>
          <a className="button primary" href="/api/auth/github"><Icon name="github" />Sign in with GitHub</a>
        </div>
      </header>

      <main className="landing-main">
        <section className="hero">
          <div>
            <span className="hero-badge">PS-05 · Bug-fix agent for code repositories</span>
            <h1>Fix bugs, not triage them.</h1>
            <p className="hero-sub">
              AgentX reads a GitHub issue, reproduces it in a sandbox, finds the cause,
              writes a fix and tests, and opens a pull request with an explanation —
              after you review it.
            </p>
            <div className="hero-actions">
              <a className="button primary" href="/api/auth/github"><Icon name="github" />Sign in with GitHub</a>
              <a className="button secondary" href="/app">Open the app</a>
            </div>
            <p className="hero-note">GitHub sign-in only. No Google sign-in, no auto-merge, no host test runs.</p>
          </div>
          <div className="hero-card card">
            <div className="card-head"><h2>Live from GitHub</h2><span className="badge">Public repository</span></div>
            <div className="card-body">
              {repo ? (
                <>
                  <p className="mono">{repo.full_name}</p>
                  <p className="subtle">{repo.description || "No description on GitHub."}</p>
                  <div className="stats-strip">
                    <div><strong>{repo.stargazers_count}</strong><span>Stars</span></div>
                    <div><strong>{repo.forks_count}</strong><span>Forks</span></div>
                    <div><strong>{repo.open_issues_count}</strong><span>Open issues</span></div>
                    <div><strong>{formatDate(repo.updated_at)}</strong><span>Last updated</span></div>
                  </div>
                  <a href={repo.html_url} target="_blank" rel="noreferrer">View on GitHub</a>
                </>
              ) : (
                <p className="subtle">Live GitHub stats are unavailable right now, so no numbers are shown here. The app itself still works after sign-in.</p>
              )}
            </div>
          </div>
        </section>

        <section id="features" className="landing-section">
          <h2>What it actually does</h2>
          <p className="subtle">Every feature below is in the shipped app — nothing here is a mockup.</p>
          <div className="feature-grid">
            {features.map((f) => (
              <article key={f.title} className="feature-card">
                <Icon name={f.icon} size={20} />
                <h3>{f.title}</h3>
                <p className="subtle">{f.text}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="workflow" className="landing-section">
          <h2>How a fix moves</h2>
          <div className="step-grid">
            {steps.map((s) => (
              <article key={s.n} className="step-card"><strong>{s.n}</strong><h3>{s.title}</h3><p className="subtle">{s.text}</p></article>
            ))}
          </div>
        </section>

        {commits.length > 0 && (
          <section id="activity" className="landing-section">
            <h2>Latest activity, from GitHub</h2>
            <p className="subtle">The most recent commits on main — real history, not a changelog written for this page.</p>
            <div className="card"><div className="list">
              {commits.map((c) => (
                <a key={c.sha} className="list-row" href={c.html_url} target="_blank" rel="noreferrer">
                  <span className="mono">{c.sha.slice(0, 7)}</span>
                  <div className="list-main"><span className="list-title">{c.commit.message.split("\n")[0]}</span><span className="faint">{c.commit.author.name} · {formatDate(c.commit.author.date)}</span></div>
                  <Icon name="chevron-right" />
                </a>
              ))}
            </div></div>
          </section>
        )}

        <section className="landing-section">
          <h2>Honest limits</h2>
          <div className="card card-body">
            <p className="subtle">
              Sandbox tests need a Docker daemon, so on the Vercel deployment they return 503 instead of
              silently running on the host. Workspaces on Vercel are ephemeral. For the full flow — clone,
              edit, sandbox test, approve, open a PR — run AgentX locally with git and Docker installed.
              Collaboration rooms on the Hobby plan also cap connections at 300 seconds and reconnect.
            </p>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <span>AgentX · PS-05 bug-fix agent</span>
        <a href="https://github.com/Adeen469/AgentX" target="_blank" rel="noreferrer">Adeen469/AgentX on GitHub</a>
      </footer>
    </div>
  );
}
