// The OpenBrain mark: a black square with a chevron in the accent color (themable), or the instance logo.

export function Mark({ size = 28, logoUrl }: { size?: number; logoUrl?: string | null }) {
  if (logoUrl) return <img src={logoUrl} alt="" width={size} height={size} />;
  return (
    <svg width={size} height={size} viewBox="0 0 30 30" aria-hidden="true">
      <rect width="30" height="30" rx="6" fill="#111114" />
      <path d="M8 10l5 5-5 5" stroke="var(--accent)" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M15 20h7" stroke="#FFFFFF" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}
