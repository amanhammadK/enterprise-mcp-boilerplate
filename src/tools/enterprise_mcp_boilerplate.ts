import crypto from "crypto";

const startTime = Date.now();

export interface CircuitBreakerConfig {
  failureThreshold: number;
  resetTimeoutMs: number;
  halfOpenMaxAttempts: number;
  monitoringWindowMs: number;
}

export interface CircuitBreakerState {
  state: "closed" | "open" | "half_open";
  failureCount: number;
  lastFailureTime: number;
  successCount: number;
  totalRequests: number;
}

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  keyGenerator?: (req: any) => string;
}

export interface RateLimitState {
  tokens: number;
  lastRefill: number;
  requestCount: number;
}

export interface MetricEntry {
  timestamp: string;
  name: string;
  value: number;
  tags: Record<string, string>;
  type: "counter" | "gauge" | "histogram" | "timer";
}

export interface AlertRule {
  id: string;
  name: string;
  metric: string;
  condition: "gt" | "lt" | "eq" | "gte" | "lte";
  threshold: number;
  windowMs: number;
  severity: "critical" | "warning" | "info";
  enabled: boolean;
}

export interface AlertState {
  ruleId: string;
  triggeredAt: string;
  resolvedAt?: string;
  currentValue: number;
  acknowledged: boolean;
}

export interface HealthCheckResult {
  service: string;
  status: "healthy" | "degraded" | "unhealthy";
  latencyMs: number;
  lastCheck: string;
  error?: string;
  metadata: Record<string, unknown>;
}

export interface AuditEntry {
  id: string;
  timestamp: string;
  action: string;
  resource: string;
  actor: string;
  details: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  outcome: "success" | "failure";
}

export interface EncryptedConfig {
  iv: string;
  data: string;
  tag: string;
  algorithm: string;
}

class CircuitBreaker {
  private state: CircuitBreakerState;
  private config: CircuitBreakerConfig;
  private failures: number[] = [];

  constructor(config: CircuitBreakerConfig) {
    this.config = config;
    this.state = { state: "closed", failureCount: 0, lastFailureTime: 0, successCount: 0, totalRequests: 0 };
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.state.totalRequests++;
    if (this.state.state === "open") {
      if (Date.now() - this.state.lastFailureTime >= this.config.resetTimeoutMs) {
        this.state.state = "half_open";
        this.state.successCount = 0;
      } else {
        throw new Error("Circuit breaker is OPEN - request rejected");
      }
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.state.failureCount = 0;
    this.state.successCount++;
    if (this.state.state === "half_open" && this.state.successCount >= this.config.halfOpenMaxAttempts) {
      this.state.state = "closed";
    }
  }

  private onFailure(): void {
    this.state.failureCount++;
    this.state.lastFailureTime = Date.now();
    this.failures.push(Date.now());
    this.failures = this.failures.filter(t => t > Date.now() - this.config.monitoringWindowMs);
    if (this.failures.length >= this.config.failureThreshold) {
      this.state.state = "open";
    }
  }

  getState(): CircuitBreakerState { return { ...this.state }; }
  reset(): void { this.state = { state: "closed", failureCount: 0, lastFailureTime: 0, successCount: 0, totalRequests: 0 }; this.failures = []; }
}

class RateLimiter {
  private limits: Map<string, RateLimitState> = new Map();
  private config: RateLimitConfig;

  constructor(config: RateLimitConfig) { this.config = config; }

  async checkLimit(key: string): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
    const now = Date.now();
    let state = this.limits.get(key);
    if (!state) {
      state = { tokens: this.config.maxRequests, lastRefill: now, requestCount: 0 };
      this.limits.set(key, state);
    }
    const elapsed = now - state.lastRefill;
    const refillCount = Math.floor(elapsed / this.config.windowMs) * this.config.maxRequests;
    if (refillCount > 0) {
      state.tokens = Math.min(this.config.maxRequests, state.tokens + refillCount);
      state.lastRefill = now;
    }
    if (state.tokens <= 0) {
      return { allowed: false, remaining: 0, resetAt: state.lastRefill + this.config.windowMs };
    }
    state.tokens--;
    state.requestCount++;
    return { allowed: true, remaining: state.tokens, resetAt: state.lastRefill + this.config.windowMs };
  }

  reset(key: string): void { this.limits.delete(key); }
  getStats(key: string): RateLimitState | undefined { return this.limits.get(key); }
}

class MetricsCollector {
  private metrics: MetricEntry[] = [];
  private maxEntries: number;

  constructor(maxEntries: number = 10000) { this.maxEntries = maxEntries; }

  record(name: string, value: number, type: MetricEntry["type"] = "gauge", tags: Record<string, string> = {}): void {
    this.metrics.push({ timestamp: new Date().toISOString(), name, value, tags, type });
    if (this.metrics.length > this.maxEntries) this.metrics = this.metrics.slice(-this.maxEntries);
  }

  counter(name: string, increment: number = 1, tags: Record<string, string> = {}): void {
    const existing = [...this.metrics].reverse().find(m => m.name === name && m.type === "counter");
    this.record(name, (existing?.value || 0) + increment, "counter", tags);
  }

  timer(name: string, durationMs: number, tags: Record<string, string> = {}): void {
    this.record(name, durationMs, "timer", tags);
  }

  gauge(name: string, value: number, tags: Record<string, string> = {}): void {
    this.record(name, value, "gauge", tags);
  }

  query(name: string, options?: { since?: string; limit?: number }): MetricEntry[] {
    let results = this.metrics.filter(m => m.name === name);
    if (options?.since) results = results.filter(m => m.timestamp >= options.since!);
    if (options?.limit) results = results.slice(-options.limit);
    return results;
  }

  getLatencyStats(name: string): { avg: number; p50: number; p95: number; p99: number; count: number } | null {
    const entries = this.metrics.filter(m => m.name === name && m.type === "timer");
    if (entries.length === 0) return null;
    const sorted = entries.map(e => e.value).sort((a, b) => a - b);
    const n = sorted.length;
    return {
      avg: sorted.reduce((a, b) => a + b, 0) / n,
      p50: sorted[Math.floor(n * 0.5)],
      p95: sorted[Math.floor(n * 0.95)],
      p99: sorted[Math.floor(n * 0.99)],
      count: n,
    };
  }

  getErrorRate(service: string): number {
    const total = this.metrics.filter(m => m.name === `${service}.requests`).length;
    const errors = this.metrics.filter(m => m.name === `${service}.errors`).length;
    return total === 0 ? 0 : errors / total;
  }

  export(): MetricEntry[] { return [...this.metrics]; }
}

class AlertManager {
  private rules: AlertRule[] = [];
  private alerts: AlertState[] = [];
  private metrics: MetricsCollector;

  constructor(metrics: MetricsCollector) { this.metrics = metrics; }

  addRule(rule: AlertRule): void { this.rules.push(rule); }
  removeRule(id: string): void { this.rules = this.rules.filter(r => r.id !== id); }
  getRules(): AlertRule[] { return [...this.rules]; }

  evaluate(): AlertState[] {
    const newAlerts: AlertState[] = [];
    for (const rule of this.rules.filter(r => r.enabled)) {
      const entries = this.metrics.query(rule.metric, { since: new Date(Date.now() - rule.windowMs).toISOString() });
      if (entries.length === 0) continue;
      const latest = entries[entries.length - 1].value;
      let triggered = false;
      switch (rule.condition) {
        case "gt": triggered = latest > rule.threshold; break;
        case "gte": triggered = latest >= rule.threshold; break;
        case "lt": triggered = latest < rule.threshold; break;
        case "lte": triggered = latest <= rule.threshold; break;
        case "eq": triggered = latest === rule.threshold; break;
      }
      if (triggered) {
        const existing = this.alerts.find(a => a.ruleId === rule.id && !a.resolvedAt);
        if (!existing) {
          const alert: AlertState = { ruleId: rule.id, triggeredAt: new Date().toISOString(), currentValue: latest, acknowledged: false };
          this.alerts.push(alert);
          newAlerts.push(alert);
        }
      } else {
        const existing = this.alerts.find(a => a.ruleId === rule.id && !a.resolvedAt);
        if (existing) existing.resolvedAt = new Date().toISOString();
      }
    }
    return newAlerts;
  }

  getActiveAlerts(): AlertState[] { return this.alerts.filter(a => !a.resolvedAt); }
  acknowledgeAlert(ruleId: string): void {
    const alert = this.alerts.find(a => a.ruleId === ruleId && !a.resolvedAt);
    if (alert) alert.acknowledged = true;
  }
}

class HealthProber {
  private services: Map<string, { url: string; timeoutMs: number; intervalMs: number }> = new Map();
  private results: Map<string, HealthCheckResult> = new Map();
  private intervals: Map<string, ReturnType<typeof setInterval>> = new Map();

  registerService(name: string, url: string, timeoutMs: number = 5000, intervalMs: number = 30000): void {
    this.services.set(name, { url, timeoutMs, intervalMs });
  }

  unregisterService(name: string): void {
    this.services.delete(name);
    const interval = this.intervals.get(name);
    if (interval) { clearInterval(interval); this.intervals.delete(name); }
  }

  async checkService(name: string): Promise<HealthCheckResult> {
    const service = this.services.get(name);
    if (!service) throw new Error(`Service "${name}" not registered`);
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), service.timeoutMs);
      const response = await fetch(service.url, { signal: controller.signal });
      clearTimeout(timeout);
      const latencyMs = Date.now() - start;
      const result: HealthCheckResult = {
        service: name, status: response.ok ? "healthy" : "degraded",
        latencyMs, lastCheck: new Date().toISOString(),
        metadata: { statusCode: response.status, statusText: response.statusText },
      };
      this.results.set(name, result);
      return result;
    } catch (error: any) {
      const result: HealthCheckResult = {
        service: name, status: "unhealthy", latencyMs: Date.now() - start,
        lastCheck: new Date().toISOString(), error: error.message, metadata: {},
      };
      this.results.set(name, result);
      return result;
    }
  }

  async checkAll(): Promise<HealthCheckResult[]> {
    const checks = [...this.services.keys()].map(name => this.checkService(name));
    return Promise.all(checks);
  }

  getResult(name: string): HealthCheckResult | undefined { return this.results.get(name); }
  getOverallStatus(): "healthy" | "degraded" | "unhealthy" {
    const results = [...this.results.values()];
    if (results.length === 0) return "healthy";
    if (results.some(r => r.status === "unhealthy")) return "unhealthy";
    if (results.some(r => r.status === "degraded")) return "degraded";
    return "healthy";
  }
}

class AuditLogger {
  private entries: AuditEntry[] = [];
  private maxEntries: number;

  constructor(maxEntries: number = 10000) { this.maxEntries = maxEntries; }

  log(entry: Omit<AuditEntry, "id" | "timestamp">): AuditEntry {
    const full: AuditEntry = {
      ...entry, id: crypto.randomUUID(), timestamp: new Date().toISOString(),
    };
    this.entries.push(full);
    if (this.entries.length > this.maxEntries) this.entries = this.entries.slice(-this.maxEntries);
    return full;
  }

  search(options: { action?: string; resource?: string; actor?: string; since?: string; until?: string; outcome?: string; limit?: number }): AuditEntry[] {
    let results = [...this.entries];
    if (options.action) results = results.filter(e => e.action === options.action);
    if (options.resource) results = results.filter(e => e.resource.includes(options.resource!));
    if (options.actor) results = results.filter(e => e.actor === options.actor);
    if (options.since) results = results.filter(e => e.timestamp >= options.since!);
    if (options.until) results = results.filter(e => e.timestamp <= options.until!);
    if (options.outcome) results = results.filter(e => e.outcome === options.outcome);
    if (options.limit) results = results.slice(-options.limit);
    return results;
  }

  export(format: "json" | "csv" = "json"): string {
    if (format === "csv") {
      const headers = "id,timestamp,action,resource,actor,outcome\n";
      const rows = this.entries.map(e => `${e.id},${e.timestamp},${e.action},${e.resource},${e.actor},${e.outcome}`).join("\n");
      return headers + rows;
    }
    return JSON.stringify(this.entries, null, 2);
  }

  getStats(): { total: number; byAction: Record<string, number>; byOutcome: Record<string, number> } {
    const byAction: Record<string, number> = {};
    const byOutcome: Record<string, number> = {};
    for (const entry of this.entries) {
      byAction[entry.action] = (byAction[entry.action] || 0) + 1;
      byOutcome[entry.outcome] = (byOutcome[entry.outcome] || 0) + 1;
    }
    return { total: this.entries.length, byAction, byOutcome };
  }
}

const configStore: Record<string, string> = {};
const auditEntries: AuditEntry[] = [];
const metricsCollector = new MetricsCollector();
const alertManager = new AlertManager(metricsCollector);
const healthProber = new HealthProber();

export async function healthCheck(): Promise<{ status: string; uptime: number; memory: NodeJS.MemoryUsage; timestamp: string; services: Record<string, string> }> {
  const services: Record<string, string> = {};
  const serviceResults = await healthProber.checkAll();
  for (const result of serviceResults) services[result.service] = result.status;
  return {
    status: healthProber.getOverallStatus(), uptime: Math.floor((Date.now() - startTime) / 1000),
    memory: process.memoryUsage(), timestamp: new Date().toISOString(), services,
  };
}

export async function getConfig(key: string): Promise<{ key: string; value: string } | { error: string }> {
  if (!(key in configStore)) return { error: `Key "${key}" not found` };
  return { key, value: configStore[key] };
}

export async function setConfig(key: string, value: string, encrypt: boolean = false): Promise<{ success: boolean; key: string; value: string; encrypted?: boolean }> {
  let finalValue = value;
  let encrypted = false;
  if (encrypt) {
    const enc = encryptValue(value);
    finalValue = JSON.stringify(enc);
    encrypted = true;
  }
  configStore[key] = finalValue;
  auditEntries.push({
    id: crypto.randomUUID(), timestamp: new Date().toISOString(),
    action: "config.set", resource: key, actor: "system",
    details: { encrypted }, outcome: "success",
  });
  return { success: true, key, value: finalValue, encrypted };
}

export async function deleteConfig(key: string): Promise<{ success: boolean; key: string }> {
  const existed = key in configStore;
  delete configStore[key];
  auditEntries.push({
    id: crypto.randomUUID(), timestamp: new Date().toISOString(),
    action: "config.delete", resource: key, actor: "system",
    details: { existed }, outcome: "success",
  });
  return { success: true, key };
}

export async function listConfigs(): Promise<{ configs: Record<string, string>; count: number }> {
  return { configs: { ...configStore }, count: Object.keys(configStore).length };
}

export async function logAudit(action: string, resource: string, actor: string, details?: Record<string, unknown>, outcome: "success" | "failure" = "success"): Promise<AuditEntry> {
  const entry: AuditEntry = {
    id: crypto.randomUUID(), timestamp: new Date().toISOString(),
    action, resource, actor, details: details || {}, outcome,
  };
  auditEntries.push(entry);
  if (auditEntries.length > 10000) auditEntries.splice(0, auditEntries.length - 10000);
  return entry;
}

export async function searchAudit(options: { action?: string; resource?: string; actor?: string; since?: string; until?: string; outcome?: string; limit?: number }): Promise<AuditEntry[]> {
  let results = [...auditEntries];
  if (options.action) results = results.filter(e => e.action === options.action);
  if (options.resource) results = results.filter(e => e.resource.includes(options.resource!));
  if (options.actor) results = results.filter(e => e.actor === options.actor);
  if (options.since) results = results.filter(e => e.timestamp >= options.since!);
  if (options.until) results = results.filter(e => e.timestamp <= options.until!);
  if (options.outcome) results = results.filter(e => e.outcome === options.outcome);
  if (options.limit) results = results.slice(-options.limit);
  return results;
}

export async function exportAudit(format: "json" | "csv" = "json"): Promise<string> {
  if (format === "csv") {
    const headers = "id,timestamp,action,resource,actor,outcome\n";
    const rows = auditEntries.map(e => `${e.id},${e.timestamp},${e.action},${e.resource},${e.actor},${e.outcome}`).join("\n");
    return headers + rows;
  }
  return JSON.stringify(auditEntries, null, 2);
}

export async function getAuditStats(): Promise<{ total: number; byAction: Record<string, number>; byOutcome: Record<string, number>; recentActivity: AuditEntry[] }> {
  const byAction: Record<string, number> = {};
  const byOutcome: Record<string, number> = {};
  for (const entry of auditEntries) {
    byAction[entry.action] = (byAction[entry.action] || 0) + 1;
    byOutcome[entry.outcome] = (byOutcome[entry.outcome] || 0) + 1;
  }
  return { total: auditEntries.length, byAction, byOutcome, recentActivity: auditEntries.slice(-10) };
}

export async function createCircuitBreaker(name: string, config?: Partial<CircuitBreakerConfig>): Promise<{ name: string; state: CircuitBreakerState; created: boolean }> {
  const defaultConfig: CircuitBreakerConfig = { failureThreshold: 5, resetTimeoutMs: 30000, halfOpenMaxAttempts: 3, monitoringWindowMs: 60000 };
  const finalConfig = { ...defaultConfig, ...config };
  const breaker = new CircuitBreaker(finalConfig);
  (globalThis as any)[`cb_${name}`] = breaker;
  return { name, state: breaker.getState(), created: true };
}

export async function getCircuitBreakerState(name: string): Promise<{ name: string; state: CircuitBreakerState } | { error: string }> {
  const breaker = (globalThis as any)[`cb_${name}`] as CircuitBreaker;
  if (!breaker) return { error: `Circuit breaker "${name}" not found` };
  return { name, state: breaker.getState() };
}

export async function resetCircuitBreaker(name: string): Promise<{ name: string; state: CircuitBreakerState; reset: boolean } | { error: string }> {
  const breaker = (globalThis as any)[`cb_${name}`] as CircuitBreaker;
  if (!breaker) return { error: `Circuit breaker "${name}" not found` };
  breaker.reset();
  return { name, state: breaker.getState(), reset: true };
}

export async function checkRateLimit(key: string, windowMs: number = 60000, maxRequests: number = 100): Promise<{ allowed: boolean; remaining: number; resetAt: number; key: string }> {
  const limiter = new RateLimiter({ windowMs, maxRequests });
  const result = await limiter.checkLimit(key);
  return { ...result, key };
}

export async function recordMetric(name: string, value: number, type: MetricEntry["type"] = "gauge", tags: Record<string, string> = {}): Promise<{ recorded: boolean; name: string; value: number; type: string }> {
  metricsCollector.record(name, value, type, tags);
  return { recorded: true, name, value, type };
}

export async function queryMetrics(name: string, since?: string, limit?: number): Promise<{ name: string; entries: MetricEntry[]; count: number }> {
  const entries = metricsCollector.query(name, { since, limit });
  return { name, entries, count: entries.length };
}

export async function getLatencyStats(name: string): Promise<{ name: string; stats: { avg: number; p50: number; p95: number; p99: number; count: number } | null }> {
  return { name, stats: metricsCollector.getLatencyStats(name) };
}

export async function getErrorRate(service: string): Promise<{ service: string; errorRate: number; percentage: string }> {
  const rate = metricsCollector.getErrorRate(service);
  return { service, errorRate: rate, percentage: `${(rate * 100).toFixed(2)}%` };
}

export async function createAlertRule(rule: AlertRule): Promise<{ rule: AlertRule; created: boolean }> {
  alertManager.addRule(rule);
  return { rule, created: true };
}

export async function evaluateAlerts(): Promise<{ newAlerts: AlertState[]; activeAlerts: AlertState[]; count: number }> {
  const newAlerts = alertManager.evaluate();
  const activeAlerts = alertManager.getActiveAlerts();
  return { newAlerts, activeAlerts, count: activeAlerts.length };
}

export async function registerService(name: string, url: string, timeoutMs?: number, intervalMs?: number): Promise<{ name: string; registered: boolean }> {
  healthProber.registerService(name, url, timeoutMs, intervalMs);
  return { name, registered: true };
}

export async function checkServiceHealth(name: string): Promise<HealthCheckResult> {
  return healthProber.checkService(name);
}

export async function checkAllServices(): Promise<{ results: HealthCheckResult[]; overallStatus: string }> {
  const results = await healthProber.checkAll();
  return { results, overallStatus: healthProber.getOverallStatus() };
}

export async function validateConfig(config: Record<string, unknown>): Promise<{ valid: boolean; errors: string[]; warnings: string[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const [key, value] of Object.entries(config)) {
    if (value === null || value === undefined) { warnings.push(`Key "${key}" has null/undefined value`); continue; }
    if (typeof value === "string" && value.length === 0) warnings.push(`Key "${key}" is empty string`);
    if (typeof value === "number" && (isNaN(value) || !isFinite(value))) errors.push(`Key "${key}" has invalid number value`);
    if (typeof value === "string" && (value.includes("${") || value.includes("{{"))) warnings.push(`Key "${key}" may contain unresolved template variables`);
  }
  return { valid: errors.length === 0, errors, warnings };
}

export async function encryptConfigValue(value: string, secret?: string): Promise<EncryptedConfig> {
  return encryptValue(value, secret);
}

export async function decryptConfigValue(encrypted: EncryptedConfig, secret?: string): Promise<{ value: string; decrypted: boolean }> {
  const key = secret ? crypto.createHash("sha256").update(secret).digest() : crypto.createHash("sha256").update("default-secret").digest();
  const decipher = crypto.createDecipheriv(encrypted.algorithm, key, Buffer.from(encrypted.iv, "hex"));
  decipher.setAuthTag(Buffer.from(encrypted.tag, "hex"));
  let decrypted = decipher.update(encrypted.data, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return { value: decrypted, decrypted: true };
}

function encryptValue(value: string, secret?: string): EncryptedConfig {
  const algorithm = "aes-256-gcm";
  const key = secret ? crypto.createHash("sha256").update(secret).digest() : crypto.createHash("sha256").update("default-secret").digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  let encrypted = cipher.update(value, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag();
  return { iv: iv.toString("hex"), data: encrypted, tag: tag.toString("hex"), algorithm };
}

export async function getSystemMetrics(): Promise<{ uptime: number; memory: NodeJS.MemoryUsage; cpuUsage: NodeJS.CpuUsage; timestamp: string; requestCount: number; errorRate: number }> {
  return {
    uptime: Math.floor((Date.now() - startTime) / 1000), memory: process.memoryUsage(),
    cpuUsage: process.cpuUsage(), timestamp: new Date().toISOString(),
    requestCount: metricsCollector.query("requests").length,
    errorRate: metricsCollector.getErrorRate("api"),
  };
}

export { CircuitBreaker, RateLimiter, MetricsCollector, AlertManager, HealthProber, AuditLogger };
