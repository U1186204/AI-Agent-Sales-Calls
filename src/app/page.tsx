import Link from "next/link";
import { BUSINESSES, type BusinessProfile } from "@/config/businesses";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { BusinessIcon, IconArrowRight, IconLayers, IconSearch } from "@/components/icons";

function BusinessCard({ b }: { b: BusinessProfile }) {
  return (
    <li>
      <Link href={`/chat/${b.id}`} className="biz-card">
        <span className="biz-card__top">
          <span className="biz-card__icon">
            <BusinessIcon id={b.id} />
          </span>
        </span>
        <h3 className="biz-card__name">{b.name}</h3>
        <span className="biz-card__tagline">{b.tagline}</span>
        <span className="biz-card__cta">
          Chat with {b.shortName}
          <IconArrowRight />
        </span>
      </Link>
    </li>
  );
}

export default function HomePage() {
  const products = BUSINESSES.filter((b) => b.kind === "product");
  const services = BUSINESSES.filter((b) => b.kind === "service");

  return (
    <>
      <SiteHeader current="home" />
      <main id="main" tabIndex={-1}>
        <section className="hero container" aria-labelledby="hero-title">
          <span className="hero__eyebrow">Oasis for contractors</span>
          <h1 id="hero-title" className="hero__title">
            The AI front desk for the trades.
          </h1>
          <p className="hero__lede">
            Oasis gives supply houses and home-service pros an AI agent that answers customers,
            quotes from real prices, and books the job.
          </p>
          <div className="hero__actions">
            <Link href="#businesses" className="btn">
              Try a demo business
            </Link>
          </div>
        </section>

        <section className="section section--tint" id="businesses" aria-labelledby="biz-title">
          <div className="container">
            <div className="section__head">
              <h2 id="biz-title" className="section__title">
                Pick a business. Ask it anything.
              </h2>
              <p className="section__lede">
                Five fictional contractors, each with its own catalog, prices, policies and
                calendar. The agent only knows the one you choose.
              </p>
            </div>

            <div className="group">
              <h3 className="group-title">Supply houses — ship anywhere in the US</h3>
              <ul className="biz-grid" role="list">
                {products.map((b) => (
                  <BusinessCard key={b.id} b={b} />
                ))}
              </ul>
            </div>
            <div className="group">
              <h3 className="group-title">Home services — booked on site</h3>
              <ul className="biz-grid biz-grid--3" role="list">
                {services.map((b) => (
                  <BusinessCard key={b.id} b={b} />
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section className="section" aria-labelledby="how-title">
          <div className="container">
            <div className="section__head">
              <h2 id="how-title" className="section__title">
                What the agent does
              </h2>
              <p className="section__lede">
                It works like your best counter person: it looks things up before it answers.
              </p>
            </div>
            <ol className="steps">
              <li>
                <span className="step__num" aria-hidden="true">
                  1
                </span>
                <h3 className="step__title">Answers from live data</h3>
                <p className="step__text">
                  Stock, prices, shipping, open time slots and policies come straight from the
                  business&rsquo;s records. If it can&rsquo;t look it up, it says so.
                </p>
              </li>
              <li>
                <span className="step__num" aria-hidden="true">
                  2
                </span>
                <h3 className="step__title">Quotes and schedules</h3>
                <p className="step__text">
                  It prices orders with tax and shipping to any US ZIP, or quotes a service with
                  add-ons and finds the next open appointment.
                </p>
              </li>
              <li>
                <span className="step__num" aria-hidden="true">
                  3
                </span>
                <h3 className="step__title">Checks out securely</h3>
                <p className="step__text">
                  Contact and address details go into a secure form, never the chat. You review
                  everything before you confirm.
                </p>
              </li>
            </ol>
            <p className="callout">
              <IconLayers className="callout__icon" />
              Every reply shows its work: open the &ldquo;How the agent answered&rdquo; panel to see
              each lookup, why it ran, and what came back.
            </p>
          </div>
        </section>

        <section className="container section-end" aria-labelledby="track-title">
          <div className="track-band">
            <div>
              <h2 id="track-title">Already ordered or booked?</h2>
              <p>Look it up with your reference number and email.</p>
            </div>
            <Link href="/status" className="btn btn--light">
              <IconSearch className="btn__icon" />
              Track an order or booking
            </Link>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
