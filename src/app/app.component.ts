import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

interface ArbitrageOpportunity {
  symbol: string;
  min: number;
  max: number;
  diff: number;
  netDiff: number;
  buy: OpportunityLeg;
  sell: OpportunityLeg;
  exchanges: Record<string, number>;
  tradeAmountUsd?: number;
  realProfitUsd?: number;
  validation?: OpportunityValidation;
}

interface OpportunityLeg {
  exchange: string;
  price: number;
  effectivePrice: number;
  feePercentApplied: number;
}

interface OpportunityLegValidation {
  bestPrice?: number;
  executablePrice?: number;
  slippagePercent?: number;
  volume24hQuote?: number;
}

type TransferStatus = 'ok' | 'unknown' | 'blocked' | 'unavailable';

interface TransferValidation {
  status: TransferStatus;
  network?: string;
  reason?: string;
}

interface OpportunityValidation {
  status: 'validated' | 'rejected';
  reasons?: string[];
  buy?: OpportunityLegValidation;
  sell?: OpportunityLegValidation;
  transfer?: TransferValidation;
}

type SortKey = 'netDiff' | 'diff' | 'min' | 'max' | 'profitUsd' | 'profitPercent' | 'tradeAmountUsd';
type SortDir = 'asc' | 'desc';

const DEFAULT_API_BASE = 'https://arbitrage-production-e91f.up.railway.app';
const MIN_REFRESH_INTERVAL = 3000;

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  readonly skeletonRows = Array.from({ length: 6 }, (_, i) => i);

  readonly apiBase = signal<string>(DEFAULT_API_BASE);
  readonly minRange = signal<number>(0.5);
  readonly maxRange = signal<number>(5);
  readonly useMinFilter = signal<boolean>(true);
  readonly useMaxFilter = signal<boolean>(false);
  readonly filtersOpen = signal<boolean>(false);
  readonly search = signal<string>('');
  readonly autoRefreshMs = signal<number>(15000);
  readonly autoRefreshEnabled = signal<boolean>(false);
  readonly availableExchanges = signal<string[]>([]);
  readonly selectedExchanges = signal<Set<string>>(new Set());
  readonly actionsOpen = signal<boolean>(false);
  readonly sortKey = signal<SortKey>('netDiff');
  readonly sortDir = signal<SortDir>('desc');

  readonly opportunities = signal<ArbitrageOpportunity[]>([]);
  readonly loading = signal<boolean>(false);
  readonly error = signal<string | null>(null);
  readonly lastUpdated = signal<Date | null>(null);

  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private floatingTooltipEl: HTMLDivElement | null = null;
  private floatingTooltipAnchor: Element | null = null;
  private floatingTooltipCleanup: (() => void) | null = null;

  readonly filtered = computed(() => {
    const query = this.search().trim().toUpperCase();
    const minEnabled = this.useMinFilter();
    const maxEnabled = this.useMaxFilter();
    const min = this.minRange();
    const max = this.maxRange();
    const selected = this.selectedExchanges();
    const applyExchangeFilter = selected.size > 0;

    const key = this.sortKey();
    const dir = this.sortDir();

    const valueOf = (item: ArbitrageOpportunity): number => {
      switch (key) {
        case 'profitUsd':
          return item.realProfitUsd ?? Number.NEGATIVE_INFINITY;
        case 'profitPercent':
          return this.profitPercent(item) ?? Number.NEGATIVE_INFINITY;
        case 'tradeAmountUsd':
          return item.tradeAmountUsd ?? Number.NEGATIVE_INFINITY;
        case 'diff':
          return item.diff;
        case 'min':
          return item.min;
        case 'max':
          return item.max;
        default:
          return item.netDiff;
      }
    };

    return [...this.opportunities()]
      .filter((item) => (query ? item.symbol.toUpperCase().includes(query) : true))
      .filter((item) => (!minEnabled ? true : item.netDiff >= min))
      .filter((item) => (!maxEnabled ? true : item.netDiff <= max))
      .filter((item) =>
        applyExchangeFilter ? Object.keys(item.exchanges).some((name) => selected.has(name)) : true
      )
      .sort((a, b) => {
        const aVal = valueOf(a);
        const bVal = valueOf(b);
        return dir === 'desc' ? bVal - aVal : aVal - bVal;
      });
  });

  constructor() {
    this.refresh();

    effect(() => {
      const enabled = this.autoRefreshEnabled();
      const interval = this.autoRefreshMs();
      if (enabled) {
        this.startAutoRefresh(interval);
      } else {
        this.stopAutoRefresh();
      }
    });

    effect(() => {
      // reload exchanges when API base changes
      this.apiBase();
      this.loadExchanges();
    });

    this.destroyRef.onDestroy(() => this.stopAutoRefresh());
  }

  async refresh(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const base = this.apiBase().replace(/\/$/, '');
      const url = `${base}/api/arbitrage`;
      const params: Record<string, string> = {};
      if (this.useMinFilter()) {
        params['minDiffPercent'] = String(this.minRange());
      }
      const data = await firstValueFrom(this.http.get<ArbitrageOpportunity[]>(url, { params }));
      this.opportunities.set(data);
      this.lastUpdated.set(new Date());
      this.resetSort();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch data';
      this.error.set(message);
    } finally {
      this.loading.set(false);
    }
  }

  toggleAutoRefresh(): void {
    this.autoRefreshEnabled.update((enabled) => !enabled);
  }

  updateMinRange(value: number | string): void {
    const parsed = Number(value);
    this.minRange.set(Number.isNaN(parsed) ? 0 : parsed);
  }

  updateMaxRange(value: number | string): void {
    const parsed = Number(value);
    this.maxRange.set(Number.isNaN(parsed) ? 0 : parsed);
  }

  updateAutoInterval(value: number | string): void {
    const numeric = Number(value);
    const sanitized = Math.max(MIN_REFRESH_INTERVAL, Number.isNaN(numeric) ? MIN_REFRESH_INTERVAL : numeric);
    this.autoRefreshMs.set(sanitized);
  }

  clearSearch(): void {
    this.search.set('');
  }

  toggleExchange(name: string): void {
    const current = this.selectedExchanges();
    const next = new Set(current);
    next.has(name) ? next.delete(name) : next.add(name);
    this.selectedExchanges.set(next);
  }

  resetExchangeFilter(): void {
    this.selectedExchanges.set(new Set());
  }

  isExchangeSelected(name: string): boolean {
    return this.selectedExchanges().has(name);
  }

  toggleFilters(): void {
    this.filtersOpen.update((open) => !open);
  }

  closeFilters(): void {
    this.filtersOpen.set(false);
  }

  toggleActions(): void {
    this.actionsOpen.update((open) => !open);
  }

  closeActions(): void {
    this.actionsOpen.set(false);
  }

  toggleMinFilter(): void {
    this.useMinFilter.update((value) => !value);
  }

  toggleMaxFilter(): void {
    this.useMaxFilter.update((value) => !value);
  }

  exchangesList(opportunity: ArbitrageOpportunity): { name: string; price: number }[] {
    return Object.entries(opportunity.exchanges).map(([name, price]) => ({ name, price }));
  }

  exchangesTooltip(opportunity: ArbitrageOpportunity): string {
    return Object.entries(opportunity.exchanges)
      .map(([name, price]) => `${name}: ${price.toFixed(6)}`)
      .join('\n');
  }

  showFloatingTooltip(event: Event, text: string): void {
    const content = (text ?? '').trim();
    if (!content) return;

    const anchor = event.target as Element | null;
    if (!anchor) return;
    this.floatingTooltipAnchor = anchor;

    if (!this.floatingTooltipEl) {
      const el = document.createElement('div');
      el.className = 'floating-tooltip';
      el.setAttribute('role', 'tooltip');
      document.body.appendChild(el);
      this.floatingTooltipEl = el;
    }

    this.floatingTooltipEl.textContent = content;
    this.floatingTooltipEl.style.opacity = '1';

    const reposition = () => this.positionFloatingTooltip();
    reposition();

    if (!this.floatingTooltipCleanup) {
      const onScroll = () => reposition();
      const onResize = () => reposition();
      // capture=true to catch scrolls inside table wrappers
      document.addEventListener('scroll', onScroll, true);
      window.addEventListener('resize', onResize);
      this.floatingTooltipCleanup = () => {
        document.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('resize', onResize);
      };
    }
  }

  hideFloatingTooltip(): void {
    if (this.floatingTooltipEl) {
      this.floatingTooltipEl.style.opacity = '0';
    }
    this.floatingTooltipAnchor = null;
    if (this.floatingTooltipCleanup) {
      this.floatingTooltipCleanup();
      this.floatingTooltipCleanup = null;
    }
  }

  private positionFloatingTooltip(): void {
    if (!this.floatingTooltipEl || !this.floatingTooltipAnchor) return;

    const rect = this.floatingTooltipAnchor.getBoundingClientRect();

    // Force layout to get tooltip size after text update
    const tooltipRect = this.floatingTooltipEl.getBoundingClientRect();

    const margin = 10;
    const preferredBelowTop = rect.bottom + 8;
    const preferredAboveTop = rect.top - tooltipRect.height - 8;

    const fitsBelow = preferredBelowTop + tooltipRect.height + margin <= window.innerHeight;
    const top = fitsBelow ? preferredBelowTop : Math.max(margin, preferredAboveTop);

    let left = rect.left + rect.width / 2 - tooltipRect.width / 2;
    left = Math.min(window.innerWidth - tooltipRect.width - margin, Math.max(margin, left));

    this.floatingTooltipEl.style.top = `${top}px`;
    this.floatingTooltipEl.style.left = `${left}px`;
  }

  transferBadge(opportunity: ArbitrageOpportunity): { status: TransferStatus; label: string; title: string } {
    const transfer = opportunity.validation?.transfer;
    if (!transfer) {
      return { status: 'unavailable', label: 'transfer: n/a', title: 'Transfer check data not provided' };
    }
    const label = transfer.network ? `${transfer.status} (${transfer.network})` : transfer.status;
    const title = transfer.reason ? transfer.reason : 'Transfer check result';
    return { status: transfer.status, label, title };
  }

  validationTooltip(opportunity: ArbitrageOpportunity): string {
    const lines: string[] = [];

    if (opportunity.tradeAmountUsd !== undefined) {
      lines.push(`Обсяг: ${formatNumber(opportunity.tradeAmountUsd, 0)} USD`);
    }
    if (opportunity.realProfitUsd !== undefined) {
      lines.push(`Профіт: ${formatNumber(opportunity.realProfitUsd, 2)} USD`);
    }
    const pct = this.profitPercent(opportunity);
    if (pct !== null) {
      lines.push(`Профіт, %: ${formatNumber(pct, 2)}%`);
    }

    const buyLine = executionLine(opportunity.validation?.buy);
    if (buyLine) lines.push(`Купівля: ${buyLine}`);

    const sellLine = executionLine(opportunity.validation?.sell);
    if (sellLine) lines.push(`Продаж: ${sellLine}`);

    return lines.join('\n');
  }

  buyTooltip(opportunity: ArbitrageOpportunity): string {
    const line = executionLine(opportunity.validation?.buy);
    return line ? line : 'Немає даних по виконуваній ціні (order book / ticker)';
  }

  sellTooltip(opportunity: ArbitrageOpportunity): string {
    const line = executionLine(opportunity.validation?.sell);
    return line ? line : 'Немає даних по виконуваній ціні (order book / ticker)';
  }

  buyEffectiveTooltipText(opportunity: ArbitrageOpportunity): string {
    const effective = formatFlexibleNumber(opportunity.buy.effectivePrice, 6, 0);
    return `Ефект. ${effective} (комісія ${opportunity.buy.feePercentApplied}%)\n${this.buyTooltip(opportunity)}`;
  }

  sellEffectiveTooltipText(opportunity: ArbitrageOpportunity): string {
    const effective = formatFlexibleNumber(opportunity.sell.effectivePrice, 6, 0);
    return `Ефект. ${effective} (комісія ${opportunity.sell.feePercentApplied}%)\n${this.sellTooltip(opportunity)}`;
  }

  profitPercent(opportunity: ArbitrageOpportunity): number | null {
    const pnl = opportunity.realProfitUsd;
    const size = opportunity.tradeAmountUsd;
    if (pnl === undefined || size === undefined || !Number.isFinite(pnl) || !Number.isFinite(size) || size <= 0) return null;
    return (pnl / size) * 100;
  }

  changeSort(key: SortKey): void {
    if (this.sortKey() === key) {
      this.sortDir.update((dir) => (dir === 'asc' ? 'desc' : 'asc'));
    } else {
      this.sortKey.set(key);
      this.sortDir.set(key === 'min' ? 'asc' : 'desc');
    }
  }

  private resetSort(): void {
    this.sortKey.set('netDiff');
    this.sortDir.set('desc');
  }

  trackBySymbol(_index: number, item: ArbitrageOpportunity): string {
    return item.symbol;
  }

  private async loadExchanges(): Promise<void> {
    try {
      const base = this.apiBase().replace(/\/$/, '');
      const url = `${base}/api/exchanges`;
      const list = await firstValueFrom(this.http.get<string[]>(url));
      this.availableExchanges.set(list);
    } catch (error) {
      console.warn('Не вдалося завантажити перелік бірж', error);
    }
  }

  private startAutoRefresh(intervalMs: number): void {
    this.stopAutoRefresh();
    const ms = Math.max(MIN_REFRESH_INTERVAL, intervalMs);
    this.refresh();
    this.refreshTimer = setInterval(() => this.refresh(), ms);
  }

  private stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}

function formatNumber(value: number, digits: number): string {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('uk-UA', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(value);
}

function formatFlexibleNumber(value: number, maximumFractionDigits: number, minimumFractionDigits = 0): string {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('uk-UA', {
    minimumFractionDigits,
    maximumFractionDigits
  }).format(value);
}

function executionLine(leg: OpportunityLegValidation | undefined): string | null {
  if (!leg) return null;
  const lines: string[] = [];
  if (leg.executablePrice !== undefined) lines.push(`exec ${formatNumber(leg.executablePrice, 5)}`);
  if (leg.slippagePercent !== undefined) lines.push(`slip ${formatNumber(leg.slippagePercent, 2)}%`);
  if (leg.volume24hQuote !== undefined) lines.push(`vol24h ${formatNumber(leg.volume24hQuote, 0)}`);
  return lines.length ? lines.join('\n') : null;
}
