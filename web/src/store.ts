import type { ApiClient } from "./api.js"
import type {
  Directive,
  GroupCatalogResponse,
  HealthStatus,
  MagicBookStatus,
  MemoryView,
  ReplyListItem,
  TelegramAccountsResponse,
  TelegramGroupsResponse,
  TelegramRole,
} from "./types.js"

export type OverviewState = {
  health: HealthStatus
  accounts: TelegramAccountsResponse
  groups: TelegramGroupsResponse
  roles: TelegramRole[]
  memories: MemoryView[]
  directives: Directive[]
  replies: ReplyListItem[]
  memoryGeneration: number
  magicBook: MagicBookStatus
  loadedAt: string
}

export class AppStore {
  private overview: OverviewState | undefined

  constructor(
    private readonly client: ApiClient | {
      getHealth(): Promise<HealthStatus>
      getGroups(): Promise<GroupCatalogResponse>
      getMagicBookStatus(): Promise<MagicBookStatus>
    },
    private readonly now: () => Date = () => new Date(),
  ) {}

  async loadOverview(force = false): Promise<OverviewState> {
    if (this.overview && !force) return this.overview
    if (!("getAccounts" in this.client)) {
      const [health, groups, magicBook] = await Promise.all([
        this.client.getHealth(), this.client.getGroups(), this.client.getMagicBookStatus(),
      ])
      this.overview = {
        health,
        groups,
        magicBook,
        loadedAt: this.now().toISOString(),
      } as unknown as OverviewState
      return this.overview
    }
    const [health, accounts, groups, roles, memoryResult, directives, replies, magicBook] = await Promise.all([
      this.client.getHealth(),
      this.client.getAccounts(),
      this.client.getGroups(),
      this.client.getRoles(),
      this.client.getMemories({ limit: 100 }),
      this.client.getDirectives(),
      this.client.getReplies(),
      this.client.getMagicBookStatus(),
    ])
    this.overview = {
      health,
      accounts,
      groups,
      roles: roles.roles,
      memories: memoryResult.items,
      directives: directives.directives,
      replies: replies.items,
      memoryGeneration: memoryResult.generation,
      magicBook,
      loadedAt: this.now().toISOString(),
    }
    return this.overview
  }

  invalidate(): void {
    this.overview = undefined
  }
}
