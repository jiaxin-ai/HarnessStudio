/** Compaction of autonomy-run conversations: DSH's basic engine with pressure at about `pressureTokens` (120,000).
 *
 * compaction-basic compacts at a fraction of the model window (80% by default). Every model on the model page has a
 * 1,000,000-token window, so a worker would reach 800,000 tokens before anything is compacted, while each call rereads
 * the whole context. The engine only offers that fraction and exact provider/model policies, and people add models at
 * run time, so this subclass works out the routed model's policy when it measures pressure: models whose own threshold
 * would lie above `pressureTokens` compact there and keep `pressureRetainTokens` of recent context; smaller windows keep
 * the engine's rule. Ordinary conversations use the unchanged engine of the studio preset. */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction';
import { BasicCompactionEngine, type BasicCompactionConfig, type ModelCompactPolicyConfig, type ResolvedConfig } from '@deepseek-ai/dsh-compaction-basic';
import z from '@deepseek-ai/schemastery';

export interface Config extends BasicCompactionConfig {
  /** Context size at which a large-window model compacts. */
  pressureTokens?: number;
  /** Recent context such a model keeps when it compacts; below `pressureTokens`. */
  pressureRetainTokens?: number;
}
// compaction-basic's own defaults, which its policy resolution applies when a field is left out.
const ENGINE_THRESHOLD_RATIO = 0.8, ENGINE_HEADROOM_TOKENS = 65536;

/** The policy for one routed model, or undefined when the engine's own threshold is already at or below `pressure`. */
export function pressurePolicy(target: { provider: string; model: string }, contextWindow: number, reservedTokens: number,
  pressure: number, retain: number, base: Pick<BasicCompactionConfig, 'thresholdRatio' | 'headroomTokens'> = {}): ModelCompactPolicyConfig | undefined {
  const own = Math.floor(Math.min(contextWindow * (base.thresholdRatio ?? ENGINE_THRESHOLD_RATIO), contextWindow - reservedTokens - (base.headroomTokens ?? ENGINE_HEADROOM_TOKENS)));
  if (!(own > pressure)) return undefined;
  return { provider: target.provider, model: target.model, thresholdRatio: pressure / contextWindow, retainTokens: retain };
}

export default class AutonomyCompaction extends BasicCompactionEngine {
  static Config: z<Config> = z.intersect([BasicCompactionEngine.Config, z.object({ pressureTokens: z.natural().default(120000), pressureRetainTokens: z.natural().default(40000) })]) as z<Config>;
  private readonly policies = new Map<string, ModelCompactPolicyConfig>();
  private readonly pressure: number;
  private readonly retain: number;
  private readonly thresholds: Pick<BasicCompactionConfig, 'thresholdRatio' | 'headroomTokens'>;

  constructor(ctx: Context, config: Config = {}) {
    const { pressureTokens = 120000, pressureRetainTokens = 40000, ...basic } = config;
    if (!Number.isSafeInteger(pressureTokens) || !Number.isSafeInteger(pressureRetainTokens) || pressureRetainTokens < 1 || pressureRetainTokens >= pressureTokens)
      throw new Error('autonomy-compaction: pressureRetainTokens must be a positive integer below pressureTokens');
    super(ctx, basic);
    this.pressure = pressureTokens; this.retain = pressureRetainTokens;
    this.thresholds = { ...basic.thresholdRatio === undefined ? {} : { thresholdRatio: basic.thresholdRatio }, ...basic.headroomTokens === undefined ? {} : { headroomTokens: basic.headroomTokens } };
    // The engine reads this.config for every policy decision; expose the configured policies plus the computed ones.
    const resolved = this.config;
    Object.defineProperty(this, 'config', { configurable: true, enumerable: true, get: (): ResolvedConfig => this.policies.size === 0 ? resolved
      : { ...resolved, modelPolicies: [...resolved.modelPolicies.filter(policy => !this.policies.has(`${policy.provider}/${policy.model}`)), ...this.policies.values()] } });
  }

  override async compactIfNeeded(agent: Agent, trigger: CompactionTrigger, signal: AbortSignal): Promise<CompactionResult | null> {
    const routed = agent.session.requestHeader()?.config;
    if (routed?.provider && routed.model) {
      const key = `${routed.provider}/${routed.model}`;
      try {
        const info = await this.ctx.llm.resolveModelInfo(routed.provider, routed.model, signal);
        const policy = info.context ? pressurePolicy(routed, info.context.contextWindow, routed.maxTokens ?? info.defaultMaxTokens ?? 0, this.pressure, this.retain, this.thresholds) : undefined;
        if (policy) this.policies.set(key, policy); else this.policies.delete(key);
      } catch (error) {
        // Without capacity facts the engine applies its own rule and reports the missing capacity itself.
        signal.throwIfAborted();
        this.policies.delete(key);
        this.ctx.logger.warn(`autonomy-compaction: ${key}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return super.compactIfNeeded(agent, trigger, signal);
  }
}
