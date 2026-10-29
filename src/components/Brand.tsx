import Link from "next/link";

/**
 * Oasis mark: a teal disc with a single wave line — water on the horizon.
 * Same drawing as public/oasis-mark.svg and public/favicon.svg.
 */
export function OasisMark({ className = "brand__mark" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <circle cx="16" cy="16" r="16" fill="#0a7c86" />
      <circle cx="16" cy="11.5" r="4" fill="#ffffff" opacity="0.92" />
      <path
        d="M5.5 20.5c2.2 0 3.3-1.6 5.25-1.6s3.05 1.6 5.25 1.6 3.3-1.6 5.25-1.6 3.05 1.6 5.25 1.6"
        fill="none"
        stroke="#ffffff"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function BrandLink({ label = "oasis home" }: { label?: string }) {
  return (
    <Link href="/" className="brand" aria-label={label}>
      <OasisMark />
      <span aria-hidden="true">oasis</span>
    </Link>
  );
}
