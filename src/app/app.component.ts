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

const DEFAULT_API_BASE = 'https://arbitrage-production-e91f.up.railway.app';
const MIN_REFRESH_INTERVAL = 1000;

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

  readonly apiBase = signal<string>(DEFAULT_API_BASE);
  readonly minDiffPercent = signal<number>(0.5);
  readonly search = signal<string>('');
  readonly autoRefreshMs = signal<number>(15000);
  readonly autoRefreshEnabled = signal<boolean>(false);

  readonly opportunities = signal<ArbitrageOpportunity[]>([]);
  readonly loading = signal<boolean>(false);
  readonly error = signal<string | null>(null);
  readonly lastUpdated = signal<Date | null>(null);

  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  readonly filtered = computed(() => {
    const query = this.search().trim().toUpperCase();
    const threshold = this.minDiffPercent();
    return [...this.opportunities()]
      .filter((item) => (query ? item.symbol.toUpperCase().includes(query) : true))
      .filter((item) => (Number.isFinite(threshold) ? item.netDiff >= threshold : true))
      .sort((a, b) => b.netDiff - a.netDiff);
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

    this.destroyRef.onDestroy(() => this.stopAutoRefresh());
  }

  async refresh(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const base = this.apiBase().replace(/\/$/, '');
      const url = `${base}/api/arbitrage`;
      const params = { minDiffPercent: String(this.minDiffPercent()) };
      const data = await firstValueFrom(this.http.get<ArbitrageOpportunity[]>(url, { params }));
      this.opportunities.set(data);
      this.lastUpdated.set(new Date());
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

  updateMinDiff(value: number | string): void {
    const parsed = Number(value);
    this.minDiffPercent.set(Number.isNaN(parsed) ? 0 : parsed);
  }

  updateAutoInterval(value: number | string): void {
    const numeric = Number(value);
    const sanitized = Math.max(MIN_REFRESH_INTERVAL, Number.isNaN(numeric) ? MIN_REFRESH_INTERVAL : numeric);
    this.autoRefreshMs.set(sanitized);
  }

  clearSearch(): void {
    this.search.set('');
  }

  exchangesList(opportunity: ArbitrageOpportunity): { name: string; price: number }[] {
    return Object.entries(opportunity.exchanges).map(([name, price]) => ({ name, price }));
  }

  trackBySymbol(_index: number, item: ArbitrageOpportunity): string {
    return item.symbol;
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
