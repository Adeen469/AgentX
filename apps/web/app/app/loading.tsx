// Shown while an /app/* route's server render is in flight. The app
// shell itself (AgentXApp) has its own session/repositories loading
// states once it mounts.
export default function Loading() {
  return (
    <div className="app">
      <main className="main" id="main">
        <div className="content">
          <p className="subtle" role="status">Loading the app…</p>
        </div>
      </main>
    </div>
  );
}
