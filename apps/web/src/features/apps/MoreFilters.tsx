import { Dropdown } from '../../components/Dropdown';
import { Icon } from '../../shell/icons';

/**
 * The "More" menu next to a list's main filter tabs: extra filters and the sort order, each a group of choices, so the
 * toolbar keeps its few tabs. Choosing keeps the menu open (several groups can be set); the button shows how many
 * groups aren't on their default, and Reset puts them all back.
 */
export interface MoreGroup<K extends string = string> {
  key: K;
  label: string;
  options: { value: string; label: string; count?: number }[];
}

export function MoreFilters<K extends string>({
  groups,
  values,
  defaults,
  onChange,
}: {
  groups: MoreGroup<K>[];
  values: Record<K, string>;
  defaults: Record<K, string>;
  onChange: (key: K, value: string) => void;
}) {
  const changed = groups.filter((g) => values[g.key] !== defaults[g.key]).length;
  return (
    <Dropdown
      label="More filters and sort order"
      placement="down-left"
      floating
      menuClassName="more-filters"
      trigger={(t) => (
        <button
          type="button"
          className={`btn btn--sm btn--ghost more-filters-btn${changed ? ' is-set' : ''}`}
          onClick={t.toggle}
          aria-expanded={t['aria-expanded']}
          aria-haspopup={t['aria-haspopup']}
          title="More filters and sort order"
          aria-label={changed ? `More filters and sort order, ${changed} set` : 'More filters and sort order'}
        >
          <Icon name="sliders" />
          More
          {changed > 0 && <span className="tab-count">{changed}</span>}
        </button>
      )}
    >
      {() => (
        <>
          {groups.map((g) => (
            <div key={g.key} className="more-filters-group" role="group" aria-label={g.label}>
              <div className="more-filters-label">{g.label}</div>
              {g.options.map((o) => {
                const on = values[g.key] === o.value;
                return (
                  <button
                    key={o.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={on}
                    className={`dd-menu-item${on ? ' is-active' : ''}`}
                    onClick={() => onChange(g.key, o.value)}
                  >
                    <span className="more-filters-check">{on && <Icon name="check" />}</span>
                    <span className="dd-menu-text">
                      <span>{o.label}</span>
                    </span>
                    {o.count !== undefined && <span className="tab-count">{o.count}</span>}
                  </button>
                );
              })}
            </div>
          ))}
          {changed > 0 && (
            <div className="more-filters-foot">
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => groups.forEach((g) => onChange(g.key, defaults[g.key]))}>
                <Icon name="x" /> Reset
              </button>
            </div>
          )}
        </>
      )}
    </Dropdown>
  );
}
