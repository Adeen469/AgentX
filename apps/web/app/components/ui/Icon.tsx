type IconName =
  | "activity"
  | "check"
  | "chevron-right"
  | "folder"
  | "github"
  | "google"
  | "git-branch"
  | "home"
  | "issues"
  | "logout"
  | "menu"
  | "plug"
  | "repository"
  | "search"
  | "settings"
  | "users";

const paths: Record<IconName, JSX.Element> = {
  activity: <><path d="M3 12h4l2-7 4 14 2-7h6" /></>,
  check: <><path d="m5 12 4 4L19 6" /></>,
  "chevron-right": <><path d="m9 18 6-6-6-6" /></>,
  folder: <><path d="M3 6.5h6l2 2h10v9.5H3z" /></>,
  github: <><path d="M15 22v-3.9c0-1.1-.4-1.8-1-2.1 3.3-.4 6.7-1.6 6.7-7.1 0-1.6-.6-2.9-1.6-3.9.2-.4.7-1.9-.2-3.8 0 0-1.3-.4-4.1 1.5a14 14 0 0 0-7.5 0C6.5.8 5.2 1.2 5.2 1.2c-.9 1.9-.4 3.4-.2 3.8a5.7 5.7 0 0 0-1.6 3.9c0 5.5 3.4 6.7 6.7 7.1-.5.3-.9.9-.9 1.8V22" /><path d="M9.2 18c-3.6 1.6-3.6-1.8-5.1-2.1" /></>,
  google: <><path d="M20.5 12.2c0-.7-.1-1.4-.2-2H12v3.8h4.8a4.1 4.1 0 0 1-1.8 2.7v2.2h2.9c1.7-1.6 2.6-3.9 2.6-6.7Z" /><path d="M12 21c2.4 0 4.4-.8 5.9-2.1L15 16.7c-.8.5-1.8.8-3 .8-2.3 0-4.3-1.6-5-3.8H4v2.3A9 9 0 0 0 12 21Z" /><path d="M7 13.7a5.4 5.4 0 0 1 0-3.4V8H4a9 9 0 0 0 0 8l3-2.3Z" /><path d="M12 6.5c1.3 0 2.5.4 3.4 1.3l2.6-2.6C16.4 3.7 14.4 3 12 3a9 9 0 0 0-8 5l3 2.3c.7-2.2 2.7-3.8 5-3.8Z" /></>,
  "git-branch": <><circle cx="6" cy="5" r="2" /><circle cx="18" cy="19" r="2" /><circle cx="18" cy="5" r="2" /><path d="M8 5h4a6 6 0 0 1 6 6v6M6 7v10a2 2 0 0 0 2 2h8" /></>,
  home: <><path d="m3 11 9-8 9 8v9H3z" /><path d="M9 20v-6h6v6" /></>,
  issues: <><circle cx="12" cy="12" r="8.5" /><path d="M12 8v5M12 16h.01" /></>,
  logout: <><path d="M10 17l5-5-5-5M15 12H3M21 19V5a2 2 0 0 0-2-2h-5" /></>,
  menu: <><path d="M4 7h16M4 12h16M4 17h16" /></>,
  plug: <><path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0zM12 16v5" /></>,
  repository: <><path d="M5 3h10a4 4 0 0 1 4 4v14H8a3 3 0 0 1-3-3z" /><path d="M8 21a3 3 0 0 1 0-6h11M9 7h6M9 11h6" /></>,
  search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 5 5" /></>,
  settings: <><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" /><path d="m19.4 15 .1.1a1.8 1.8 0 0 1-2.5 2.5l-.1-.1a1.8 1.8 0 0 0-3 .9v.2a1.8 1.8 0 0 1-3.6 0v-.2a1.8 1.8 0 0 0-3-.9l-.1.1a1.8 1.8 0 1 1-2.5-2.5l.1-.1a1.8 1.8 0 0 0-.9-3h-.2a1.8 1.8 0 0 1 0-3.6H4a1.8 1.8 0 0 0 .9-3l-.1-.1a1.8 1.8 0 1 1 2.5-2.5l.1.1a1.8 1.8 0 0 0 3-.9v-.2a1.8 1.8 0 0 1 3.6 0v.2a1.8 1.8 0 0 0 3 .9l.1-.1a1.8 1.8 0 1 1 2.5 2.5l-.1.1a1.8 1.8 0 0 0 .9 3h.2a1.8 1.8 0 0 1 0 3.6h-.2a1.8 1.8 0 0 0-.9 3Z" /></>,
  users: <><path d="M16 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20M9.5 10.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM17 3.7a3.5 3.5 0 0 1 0 6.8M21 20v-1.5a4 4 0 0 0-3-3.8" /></>,
};

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
