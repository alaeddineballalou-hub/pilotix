// Pilot AI › Dellal AI: how Dellal learns, drawn as the loop it runs every day (the day it sells, the night Pilot AI
// reads the finished chats, the morning the coach decides, the test that the parcels judge), its rules in simple words
// (always the engine's own numbers), and its instruction book: put together on the server at each click, so a download
// is always the latest version.
import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dateOnly, n } from '../../lib/format';
import { POut, prpc } from '../../lib/platform';
import { Card, Icon } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';

type State = POut<'p.pilot.state'>;
const STEPS = ['day', 'night', 'morning', 'test'] as const;

/** The loop: four stations on a track that goes round (the dot runs it, unless the reader asked for less motion). */
export function LearnCard({ d }: { d: State }) {
  const { t, i18n } = useTranslation();
  const wrap = useRef<HTMLOListElement>(null);
  const [g, setG] = useState<{ w: number; h: number; dots: { x: number; y: number }[]; wide: boolean; rtl: boolean } | null>(null);
  const [still, setStill] = useState(false);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    setStill(!!mq?.matches);
    const measure = () => {
      const b = el.getBoundingClientRect();
      const dots = [...el.querySelectorAll<HTMLElement>('.pl-dot')].map((m) => {
        const r = m.getBoundingClientRect();
        return { x: r.left - b.left + r.width / 2, y: r.top - b.top + r.height / 2 };
      });
      if (dots.length === STEPS.length) setG({ w: b.width, h: b.height, dots, wide: Math.abs(dots[0].y - dots[1].y) < 2, rtl: getComputedStyle(el).direction === 'rtl' });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [i18n.language]);
  const track = g ? loopPath(g) : null;
  const r = d.rules;
  const sc = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${String(Math.abs(v)).replace('.', i18n.language === 'en' ? '.' : ',')}`;
  return (
    <Card title={t('platform.pilot.learn.title')} help={t('platform.pilot.learn.help')} className="pl-card">
      <p className="pl-lead">{t('platform.pilot.learn.lead')}</p>
      <div className="pl-stage">
        {g && track && (
          <svg className="pl-track" width={g.w} height={g.h} viewBox={`0 0 ${g.w} ${g.h}`} aria-hidden="true">
            <path className="pl-line" d={track.d} />
            {track.arrows.map((a, i) => (
              <path key={i} className="pl-arrow" d="M-4,-4.5 L2.5,0 L-4,4.5" transform={`translate(${a.x.toFixed(1)},${a.y.toFixed(1)}) rotate(${a.a})`} />
            ))}
            {!still && (
              <circle className="pl-run" r={5}>
                <animateMotion dur="14s" repeatCount="indefinite" path={track.d} />
              </circle>
            )}
          </svg>
        )}
        <ol className="pl-steps" ref={wrap}>
          {STEPS.map((k, i) => (
            <li key={k} className={`pl-step pl-${k}`}>
              <span className="pl-dot ltr" aria-hidden="true">
                {i + 1}
              </span>
              <span className="pl-when">{t(`platform.pilot.learn.${k}.when`)}</span>
              <b className="pl-what">{t(`platform.pilot.learn.${k}.what`)}</b>
              <span className="pl-text">{t(`platform.pilot.learn.${k}.text`, { share: Math.round(d.config.share * 100), days: r.matureDays })}</span>
            </li>
          ))}
        </ol>
      </div>
      <p className="pl-again">
        <Icon name="undo" /> {t('platform.pilot.learn.again')}
      </p>

      <div className="pl-rules">
        <div>
          <h3 className="pb-h">{t('platform.pilot.learn.scoreTitle')}</h3>
          <p className="small muted">{t('platform.pilot.learn.scoreLead')}</p>
          <table className="pl-score">
            <tbody>
              {(
                [
                  ['delivered', r.score.delivered],
                  ['exchanged', r.score.exchanged],
                  ['refused', r.score.refused],
                  ['wrong_number', r.score.wrong_number],
                  ['cancelled', r.score.cancelled],
                  ['no_order', 0],
                ] as const
              ).map(([k, v]) => (
                <tr key={k}>
                  <td>{t(`platform.pilot.learn.score.${k}`)}</td>
                  <td className={`num ltr ${v > 0 ? 'pl-plus' : v < 0 ? 'pl-minus' : ''}`}>{sc(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small">{t('platform.pilot.learn.gold', { gold: String(r.gold).replace('.', i18n.language === 'en' ? '.' : ',') })}</p>
        </div>
        <div>
          <h3 className="pb-h">{t('platform.pilot.learn.rulesTitle')}</h3>
          <ul className="pl-list">
            <li>{t('platform.pilot.learn.rule.win')}</li>
            <li>{t('platform.pilot.learn.rule.safe')}</li>
            <li>{t('platform.pilot.learn.rule.short', { open: r.maxOpen })}</li>
            <li>{t('platform.pilot.learn.rule.brain')}</li>
            <li>{t('platform.pilot.learn.rule.test', { min: n(r.minPass), days: r.matureDays, max: r.maxTestDays })}</li>
            <li>{t('platform.pilot.learn.rule.budget', { usd: d.config.maxUsd.toFixed(2) })}</li>
          </ul>
        </div>
      </div>
    </Card>
  );
}

/**
 * The track through the four stations. Wide (a row): along the stations, down the far side, back along the bottom and up
 * — the dot goes round the steps. Narrow (a column): down through the stations, then back up on the outside. Right to
 * left in Arabic, like the reading.
 */
function loopPath(g: { w: number; h: number; dots: { x: number; y: number }[]; wide: boolean; rtl: boolean }) {
  const { w, h, dots, wide, rtl } = g;
  const r = 14;
  const first = dots[0];
  const last = dots[dots.length - 1];
  const arrows: { x: number; y: number; a: number }[] = [];
  let d: string;
  if (wide) {
    const y0 = first.y;
    const y1 = h - 6;
    const a = rtl ? w - 6 : 6; // the side the dot comes back up on
    const b = rtl ? 6 : w - 6; // the side it goes down on
    const s = rtl ? -1 : 1; // the direction of the reading
    d = `M${first.x},${y0} L${b - s * r},${y0} Q${b},${y0} ${b},${y0 + r} L${b},${y1 - r} Q${b},${y1} ${b - s * r},${y1} L${a + s * r},${y1} Q${a},${y1} ${a},${y1 - r} L${a},${y0 + r} Q${a},${y0} ${a + s * r},${y0} Z`;
    for (let i = 0; i < dots.length - 1; i++) arrows.push({ x: (dots[i].x + dots[i + 1].x) / 2, y: y0, a: rtl ? 180 : 0 });
    arrows.push({ x: b, y: (y0 + y1) / 2, a: 90 }, { x: w / 2, y: y1, a: rtl ? 0 : 180 }, { x: a, y: (y0 + y1) / 2, a: 270 });
  } else {
    const x0 = first.x;
    const xo = rtl ? w - 8 : 8; // the outside line, back up
    const s = rtl ? 1 : -1; // from the stations towards the outside
    const yt = first.y;
    const yb = last.y + 22;
    d = `M${x0},${yt} L${x0},${yb - r} Q${x0},${yb} ${x0 + s * r},${yb} L${xo - s * r},${yb} Q${xo},${yb} ${xo},${yb - r} L${xo},${yt - 22 + r} Q${xo},${yt - 22} ${xo - s * r},${yt - 22} L${x0 + s * r},${yt - 22} Q${x0},${yt - 22} ${x0},${yt - 22 + r} Z`;
    for (let i = 0; i < dots.length - 1; i++) arrows.push({ x: x0, y: (dots[i].y + dots[i + 1].y) / 2, a: 90 });
    arrows.push({ x: xo, y: (yt + yb) / 2, a: 270 });
  }
  return { d, arrows };
}

/** Dellal's instruction book: the version in service, the one in test, and the file (made at the click: the latest). */
export function BookCard({ d }: { d: State }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [read, setRead] = useState<string | null>(null);
  const champion = d.books.books.find((b) => b.status === 'champion') ?? null;
  const testing = d.books.test ? d.books.books.find((b) => b.id === d.books.test!.challengerId) ?? null : null;
  const get = async (show: boolean) => {
    setBusy(true);
    try {
      const b = await prpc('p.pilot.bookText', {});
      if (show) setRead(b.text);
      else saveText(`dellal-livre-${b.version ? `v${b.version}` : 'base'}-${new Date().toISOString().slice(0, 10)}.txt`, b.text);
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={t('platform.pilot.book.title')} help={t('platform.pilot.book.help')} className="pl-book">
      <p className="small">{t('platform.pilot.book.what')}</p>
      <p className="pl-book-v">
        {champion ? (
          <>
            <b className="ltr">v{champion.version}</b> {t('platform.pilot.book.since', { date: dateOnly(champion.promotedAt ?? champion.createdAt), count: champion.lessons, n: n(champion.lessons) })}
          </>
        ) : (
          t('platform.pilot.book.base')
        )}
      </p>
      {testing && d.books.test && <p className="small muted">{t('platform.pilot.book.testing', { v: testing.version, share: Math.round(d.books.test.share * 100) })}</p>}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn primary" disabled={busy} onClick={() => get(false)}>
          <Icon name="download" /> {t('platform.pilot.book.download')}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => get(true)}>
          <Icon name="eye" /> {t('platform.pilot.book.read')}
        </button>
      </div>
      <p className="small muted">{t('platform.pilot.book.always')}</p>
      {read !== null && (
        <Modal title={t('platform.pilot.book.title')} onClose={() => setRead(null)} sheet>
          <pre className="pilot-transcript pl-book-text">{read}</pre>
        </Modal>
      )}
    </Card>
  );
}

function saveText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
