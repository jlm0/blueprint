import { boundaryDisplayName } from '../core/activity';
import { boundaryId } from '../core/address';
import { type DesignFinding, collectDesignFindings, designFindingReference } from '../core/findings';
import type { CanvasProjectBundle, ScreenDefinition } from '../core/types';
import { activeBoardId, boardState, project } from './canvas-state';
import { copyText, el } from './dom';
import { createFrameOverlay, resetFrameOverlay, showFrameOverlay } from './frame-overlay';
import { prototypeUsesByHost } from './frame-uses';

export const findingOverlay = createFrameOverlay('bp-chrome-finding-layer', 'bp-chrome-finding-box', 'findingBoundaryIds');

const designFindingsByBundle = new WeakMap<CanvasProjectBundle, DesignFinding[]>();

export let findingsPanelState: { title: string; boundaryIds: string[] } | undefined;
let findingsPanel: HTMLElement;

export function createFindingsPanel(): HTMLElement {
  findingsPanel = el('aside', 'bp-chrome-findings');
  findingsPanel.hidden = true;
  findingsPanel.setAttribute('aria-label', 'Design findings');
  return findingsPanel;
}

export function designFindings(bundle: CanvasProjectBundle): DesignFinding[] {
  let findings = designFindingsByBundle.get(bundle);
  if (!findings) {
    findings = collectDesignFindings(bundle);
    designFindingsByBundle.set(bundle, findings);
  }
  return findings;
}

export function frameFindingBoundaryIds(bundle: CanvasProjectBundle, screen: ScreenDefinition, usedBoundaryIds: Iterable<string>): string[] {
  return [...new Set([
    boundaryId(bundle.manifest.project.id, 'screen', screen.id),
    ...usedBoundaryIds,
    ...bundle.tokens.tokenGroups.map(group => boundaryId(bundle.manifest.project.id, 'token-group', group.id))
  ])];
}

export function renderFindingAnnotations(): void {
  resetFrameOverlay(findingOverlay);
  renderFindingsPanel();
  const root = activeBoardId === 'screens' ? boardState.get('screens')?.root : undefined;
  if (!root) return;
  const componentIds = new Set(designFindings(project).filter(finding => finding.kind === 'component').map(finding => finding.boundaryId));
  if (componentIds.size === 0) return;
  for (const host of root.querySelectorAll<HTMLElement>('.canonical-prototype-screen')) {
    const flagged = new Set([...prototypeUsesByHost.get(host)?.usedBoundaryIds ?? []].filter(id => componentIds.has(id)));
    if (flagged.size > 0) showFrameOverlay(findingOverlay, host, flagged);
  }
}

export function openFindingsPanel(state: { title: string; boundaryIds: string[] }): void {
  findingsPanelState = state;
  renderFindingsPanel();
}

export function closeFindingsPanel(): void {
  findingsPanelState = undefined;
  renderFindingsPanel();
}

function renderFindingsPanel(): void {
  findingsPanel.replaceChildren();
  findingsPanel.hidden = !findingsPanelState;
  if (!findingsPanelState) return;
  const { boundaryIds, title } = findingsPanelState;
  const findings = designFindings(project).filter(finding => boundaryIds.includes(finding.boundaryId));
  const header = el('header', 'bp-chrome-findings-header');
  const heading = el('div', 'bp-chrome-findings-title');
  heading.append(el('strong', '', title), el('span', '', findings.length === 1 ? '1 finding' : `${findings.length} findings`));
  const copyAll = el('button', 'bp-chrome-findings-copy', 'Copy all') as HTMLButtonElement;
  copyAll.type = 'button';
  copyAll.disabled = findings.length === 0;
  copyAll.addEventListener('click', () => {
    void copyText(findings.map(designFindingReference).join('\n')).then(() => flashCopied(copyAll));
  });
  const close = el('button', 'bp-chrome-findings-close', '×') as HTMLButtonElement;
  close.type = 'button';
  close.title = 'Close findings';
  close.setAttribute('aria-label', 'Close findings');
  close.addEventListener('click', closeFindingsPanel);
  header.append(heading, copyAll, close);
  const list = el('ol', 'bp-chrome-findings-list');
  for (const finding of findings) {
    const item = el('li', 'bp-chrome-findings-item');
    item.dataset.findingBoundaryId = finding.boundaryId;
    item.dataset.findingRule = finding.rule;
    const meta = el('div', 'bp-chrome-findings-meta');
    meta.append(
      el('span', 'bp-chrome-findings-boundary', boundaryDisplayName(project, finding.kind, finding.localId)),
      el('code', 'bp-chrome-findings-location', finding.location)
    );
    const copy = el('button', 'bp-chrome-findings-copy', 'Copy') as HTMLButtonElement;
    copy.type = 'button';
    copy.title = 'Copy this finding for the agent';
    copy.addEventListener('click', () => {
      void copyText(designFindingReference(finding)).then(() => flashCopied(copy));
    });
    item.append(meta, el('p', 'bp-chrome-findings-message', finding.message), copy);
    list.append(item);
  }
  if (findings.length === 0) list.append(el('li', 'bp-chrome-findings-empty', 'No findings remain.'));
  findingsPanel.append(header, list);
}

function flashCopied(button: HTMLButtonElement): void {
  const label = button.textContent;
  button.textContent = 'Copied';
  window.setTimeout(() => {
    button.textContent = label;
  }, 1_000);
}
