import type { ReactNode } from 'react';

export function PageHeader({ eyebrow, title, accent, sub, actions }: {
  eyebrow: string;
  title: string;
  accent?: string;
  sub?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="hero">
      <div className="hero-text">
        <span className="eyebrow">{eyebrow}</span>
        <h1 className="hero-title">
          {title} {accent && <span className="accent">{accent}</span>}
        </h1>
        {sub && <p className="hero-sub">{sub}</p>}
      </div>
      {actions && <div className="hero-actions">{actions}</div>}
    </section>
  );
}
