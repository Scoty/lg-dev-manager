import type { ReactNode } from 'react';

export function Card({ eyebrow, title, action, className = 'col-12', children }: {
  eyebrow?: string;
  title: string;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`card ${className}`}>
      <div className="card-head">
        <div className="card-title-wrap">
          {eyebrow && <span className="eyebrow">{eyebrow}</span>}
          <h2 className="card-title">{title}</h2>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
