import { useLayoutEffect, useRef, useState } from 'react';
import type { LandShowcaseItem } from '@agentzero/contracts';
import styles from './land-showcase.module.css';

const labels = { text: '文字', image: '图片', video: '视频', webpage: '网页' };

function WebpagePreview({ url, title }: { url: string; title: string }) {
  const viewport = useRef<HTMLDivElement>(null), frame = useRef<HTMLIFrameElement>(null);
  useLayoutEffect(() => {
    const container = viewport.current!, iframe = frame.current!;
    const resize = () => {
      const width = container.clientWidth, height = container.clientHeight;
      if (!width || !height) return;
      const pageWidth = Math.max(1024, width), scale = width / pageWidth;
      iframe.style.width = pageWidth + 'px';
      iframe.style.height = height / scale + 'px';
      iframe.style.transform = `scale(${scale})`;
    };
    resize();
    const observer = new ResizeObserver(resize); observer.observe(container);
    return () => observer.disconnect();
  }, []);
  return <div ref={viewport} className={styles.webViewport} data-webpage-viewport>
    <iframe ref={frame} src={url} title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" loading="lazy" />
  </div>;
}

function ShowcaseItem({ item }: { item: LandShowcaseItem }) {
  const [failed, setFailed] = useState(false), [preview, setPreview] = useState(true);
  const title = item.title || labels[item.type];
  return <article className={styles.item} data-showcase-type={item.type}>
    {item.title && <h3>{item.title}</h3>}
    {item.type === 'text' ? <p className={styles.text}>{item.text}</p> : <>
      {item.type === 'image' && !failed && <img src={item.url} alt={title} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />}
      {item.type === 'video' && !failed && <video src={item.url} aria-label={title} controls playsInline preload="none" onError={() => setFailed(true)} />}
      {item.type === 'webpage' && <><div className={styles.webPreview}><span>{new URL(item.url).hostname}</span><div className={styles.webActions}><button className={styles.previewToggle} type="button" aria-expanded={preview} onClick={() => setPreview(value => !value)}>{preview ? '收起预览' : '展开预览'}</button><a className={styles.openWeb} href={item.url} target="_blank" rel="noopener noreferrer">打开网页 ↗</a></div></div>
        {preview && <><WebpagePreview url={item.url} title={title} /><p className={`${styles.hint} ${styles.webHint}`}>可在网页内滚动浏览。部分网站禁止内嵌或需要登录，可点击“打开网页”。</p></>}
      </>}
      {failed && <p className={styles.hint}>{labels[item.type]}暂时无法加载，可打开原链接查看。</p>}
      {item.type !== 'webpage' && <a className={styles.source} href={item.url} target="_blank" rel="noreferrer">打开{labels[item.type]} ↗</a>}
    </>}
  </article>;
}

export function LandShowcase({ items, compact = false }: { items: LandShowcaseItem[]; compact?: boolean }) {
  const [page, setPage] = useState(0);
  if (!items.length) return null;
  const index = Math.min(page, items.length - 1), visible = compact ? [items[index]!] : items;
  return <div className={`${styles.showcase} ${compact ? styles.compact : ''}`}>
    {visible.map((item, position) => <ShowcaseItem key={`${compact ? index : position}:${JSON.stringify(item)}`} item={item} />)}
    {compact && items.length > 1 && <nav className={styles.pagination} aria-label="切换展示内容"><button type="button" aria-label="上一个展示" disabled={index === 0} onClick={() => setPage(index - 1)}>←</button><span>{index + 1} / {items.length}</span><button type="button" aria-label="下一个展示" disabled={index === items.length - 1} onClick={() => setPage(index + 1)}>→</button></nav>}
  </div>;
}
