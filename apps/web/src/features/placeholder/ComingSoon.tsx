import { Link } from 'react-router-dom';
import { Icon, type IconName } from '../../shell/icons';
import { PageHeader } from '../../components/PageHeader';
import { useBridge } from '../../bridge/BridgeProvider';

/** Stand-in for pages that land in later milestones (see PLAN.md §5). */
export function ComingSoon({ eyebrow, title, icon, milestone, description }: {
  eyebrow: string;
  title: string;
  icon: IconName;
  milestone: string;
  description: string;
}) {
  const { status } = useBridge();
  return (
    <>
      <PageHeader eyebrow={eyebrow} title={title} />
      <div className="grid">
        <section className="card col-12">
          <div className="empty-state">
            <div className="empty-icon"><Icon name={icon} /></div>
            <h3>Coming in {milestone}</h3>
            <p>{description}</p>
            {status.state !== 'connected' && (
              <Link to="/bridge" className="btn btn--soft-primary">
                <Icon name="plug" /> Set up the bridge first
              </Link>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
