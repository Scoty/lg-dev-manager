import type { RepoPackage } from '@lgdm/protocol';
import { useRepoImage } from './queries';

const TINTS = ['primary', 'success', 'purple', 'orange', 'pink', 'teal', 'info'] as const;
const tintFor = (id: string) => {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TINTS[h % TINTS.length];
};

/** A repository app's icon (loaded through the bridge); its initial on a tinted tile until then. */
export function RepoIcon({ pkg, size = 44, detail = false }: { pkg: RepoPackage; size?: number; detail?: boolean }) {
  const { data } = useRepoImage((detail && pkg.detailIconUri) || pkg.iconUri);
  const style = { width: size, height: size };
  if (data) return <img className="app-icon repo-icon" src={data} alt="" width={size} height={size} style={style} />;
  return (
    <span className={`app-icon app-icon--fallback repo-icon tint-${tintFor(pkg.id)}`} style={{ ...style, fontSize: Math.round(size * 0.4) }} aria-hidden="true">
      {pkg.title.trim().slice(0, 1).toUpperCase()}
    </span>
  );
}

/** A screenshot from the repository. */
export function RepoScreenshot({ url, caption }: { url: string; caption?: string }) {
  const { data, isError } = useRepoImage(url);
  if (isError) return null;
  return (
    <figure className="repo-shot">
      {data ? <img src={data} alt={caption ?? 'Screenshot'} /> : <div className="repo-shot-ph"><span className="spinner sm" /></div>}
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}
