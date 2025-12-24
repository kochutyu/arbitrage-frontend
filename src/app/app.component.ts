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
}

interface OpportunityLeg {
  exchange: string;
  price: number;
  effectivePrice: number;
  feePercentApplied: number;
}

type SortKey = 'netDiff' | 'diff' | 'min' | 'max';
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
