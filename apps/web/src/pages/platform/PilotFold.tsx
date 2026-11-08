// A lab card that opens and folds from its title row: the push card and the exam. Both are folded when the page opens
// (they open when a button elsewhere leads there, e.g. « Passer l'examen »). Folded, the row still says where things are.
// The content stays on the page while folded (an exam that runs keeps being followed, a choice made stays).
import { useId, type ReactNode } from 'react';
import { Help, Icon } from '../../ui/kit';

export function FoldCard({
  title,
  badge,
  help,
  sum,
  open,
  onOpen,
  className = '',
  children,
}: {
  title: string;
  badge?: ReactNode;
  help?: string;
  /** one short line shown while folded (where things are) */
  sum?: ReactNode;
  open: boolean;
  onOpen: (open: boolean) => void;
  className?: string;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <section className={`card pl-fold${open ? ' open' : ''} ${className}`}>
      <div
        className="card-head pl-fold-head"
        onClick={(e) => {
          // the whole row opens it (the « ? » and the buttons do their own thing)
          if (!(e.target as HTMLElement).closest('button, a, .px-help, .px-tip')) onOpen(!open);
        }}
      >
        <h2>
          <button type="button" className="pl-fold-btn" aria-expanded={open} aria-controls={id} onClick={() => onOpen(!open)}>
            <Icon name="chevron" />
            {title}
          </button>
          {badge !== undefined && <> {badge}</>}
          {help && <Help text={help} label={title} />}
        </h2>
        {!open && sum ? <span className="pl-fold-sum small">{sum}</span> : null}
      </div>
      <div id={id} className="pl-fold-body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}
