import { useEffect, useRef, useState, type ReactNode } from 'react';
import shell from './shell.module.css';

const portraitPhone = '(pointer: coarse) and (max-width: 600px) and (orientation: portrait)';

export function MobileLandscape({ children }: { children: ReactNode }) {
  const [portrait, setPortrait] = useState(() => window.matchMedia(portraitPhone).matches);
  const [notice, setNotice] = useState(''), [pending, setPending] = useState(false);
  const enter = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const media = window.matchMedia(portraitPhone), update = () => setPortrait(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (portrait) { document.exitPointerLock?.(); enter.current?.focus(); }
  }, [portrait]);
  const rotate = async () => {
    setPending(true); setNotice('');
    try {
      const orientation = screen.orientation as ScreenOrientation & { lock?: (orientation: 'landscape') => Promise<void> };
      if (!orientation?.lock || !document.documentElement.requestFullscreen) throw new Error('unavailable');
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      await orientation.lock('landscape');
    } catch { setNotice('请开启手机自动旋转，并将手机横放后继续。'); }
    finally { setPending(false); }
  };
  return <>
    <div inert={portrait} aria-hidden={portrait || undefined}>{children}</div>
    {portrait && <section className={shell.landscapePrompt} role="dialog" aria-modal="true" aria-labelledby="landscape-title">
      <div className={shell.landscapePhone} aria-hidden>↻</div><h1 id="landscape-title">横屏进入 Agent 小镇</h1><p>请将手机横放，获得更宽阔的视野。</p>
      <button ref={enter} disabled={pending} onClick={() => void rotate()}>{pending ? '正在切换…' : '切换横屏'}</button>
      {notice && <p role="status">{notice}</p>}
    </section>}
  </>;
}
