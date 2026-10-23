type LogoProps = { compact?: boolean };

export function Logo({ compact = false }: LogoProps) {
  return (
    <span className="brand" aria-label="AgentX">
      <span className="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
          <path d="M5 7.5 8 5l3 2.5L14 5l3 2.5L19 5v7.5l-3 2.5-3-2.5-3 2.5-3-2.5V7.5Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
          <path d="M8 17.5 11 20l3-2.5 3 2.5" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        </svg>
      </span>
      {!compact && <span className="brand-text">AgentX</span>}
    </span>
  );
}
