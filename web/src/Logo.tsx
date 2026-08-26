// Captioneer mark: a rising sun over the "thousand hills", with a caption bar —
// a quiet nod to Rwanda, abstract rather than flag clip-art.
export default function Logo({ size = 44 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="cap-bg" x1="0" y1="0" x2="48" y2="48">
          <stop stopColor="#16171b" />
          <stop offset="1" stopColor="#0c0c0f" />
        </linearGradient>
        <linearGradient id="cap-sun" x1="14" y1="12" x2="34" y2="30">
          <stop stopColor="#ff9a6e" />
          <stop offset="1" stopColor="#ff5f36" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="13" fill="url(#cap-bg)" />
      <circle cx="24" cy="21" r="7.5" fill="url(#cap-sun)" />
      <path
        d="M6 33c4-6 8-6 12 0 4-6 8-6 12 0 4-6 8-6 12 0"
        stroke="#34d399"
        strokeWidth="2.4"
        strokeLinecap="round"
        fill="none"
        opacity="0.95"
      />
      <rect x="15" y="38.5" width="18" height="2.6" rx="1.3" fill="#34d399" opacity="0.85" />
    </svg>
  );
}
