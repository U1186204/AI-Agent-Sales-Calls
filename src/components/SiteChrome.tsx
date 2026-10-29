import Link from "next/link";
import { BrandLink } from "./Brand";

type NavKey = "home" | "status" | "owner";

export function SiteHeader({ current }: { current?: NavKey }) {
  return (
    <header className="site-header">
      <div className="container site-header__inner">
        <BrandLink />
        <nav aria-label="Main" className="site-nav">
          <Link href="/#businesses" aria-current={current === "home" ? "page" : undefined}>
            Businesses
          </Link>
          <Link href="/status" aria-current={current === "status" ? "page" : undefined}>
            Track an order
          </Link>
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="container site-footer__inner">
        <p>Oasis is a demo. Businesses are fictional, and no payment is collected.</p>
        <nav aria-label="Footer">
          <Link href="/status">Track an order or booking</Link>
          <Link href="/owner/login">Owner sign in</Link>
        </nav>
      </div>
    </footer>
  );
}
