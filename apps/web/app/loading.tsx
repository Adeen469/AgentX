// Shown while the landing page's server render (including the live
// GitHub fetch) is in flight, so a slow GitHub response is a loading
// state instead of a blank page.
export default function Loading() {
  return (
    <div className="landing">
      <main className="landing-main" id="main">
        <p className="subtle" role="status">Loading AgentX…</p>
      </main>
    </div>
  );
}
