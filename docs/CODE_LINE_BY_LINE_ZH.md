# agent-escrow 逐行代码讲解版

这份文档的目标不是再讲一遍“项目是什么”，而是带你按真实代码结构逐段理解：

1. 这一行或这一段代码在做什么
2. 它依赖前后哪些状态
3. 它为什么要这么写
4. 它和前端 / 测试 / 链上执行的关系是什么

建议阅读顺序：

1. `programs/agent_escrow/src/lib.rs`
2. `app/src/lib/pda.ts`
3. `app/src/lib/token.ts`
4. `app/src/lib/anchor.ts`
5. `app/src/components/*`
6. `app/src/App.tsx`
7. `tests/agent-escrow.ts`

---

## 一、链上程序逐段讲解

文件：

- [programs/agent_escrow/src/lib.rs](/home/don/codexAgentEscrow/programs/agent_escrow/src/lib.rs)

---

### 1. 顶部 imports

```rust
use anchor_lang::prelude::*;
use anchor_lang::AccountDeserialize;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, TransferChecked};
```

逐行解释：

- `anchor_lang::prelude::*`
  - 引入 Anchor 常用类型
  - 比如 `Context`、`Result`、`Account`、`Signer`、`Pubkey`、`Clock`
- `AccountDeserialize`
  - 用于后面手动读取 `TokenAccount` 数据
  - 主要服务 `token_account_matches(...)`
- `AssociatedToken`
  - 用于 account constraint 里声明 ATA 相关初始化 / 校验
- `token::{...}`
  - `Mint`：mint 账户类型
  - `Token`：token program
  - `TokenAccount`：SPL token 账户类型
  - `TransferChecked`：做安全 token 转账
  - `CloseAccount`：关闭 vault，把 rent 退回给 maker

为什么不是随便 `use`：

- 这里每一个 import 后面都会被实际用到
- 尤其 `TransferChecked` 和 `CloseAccount` 是本项目资金流的核心 CPI 类型

---

### 2. Program ID

```rust
declare_id!("3MXAtw3MNR6z2xYXwTU9zxibYL5pyiEtFjZ7Bevq5PZr");
```

解释：

- 声明这个 Anchor program 的链上地址
- 前端、测试、IDL 都要和它一致

如果这里改了：

- `Anchor.toml`
- 前端 IDL
- 部署地址

也都要同步，否则前端会调错程序。

---

### 3. PDA seed 前缀

```rust
const ESCROW_SEED_PREFIX: &[u8] = b"escrow";
```

解释：

- 这是 Escrow PDA 推导的固定前缀
- 用它可以把“这是一类 escrow PDA”这件事编码到地址推导里

后面所有 escrow PDA 都会基于：

- `"escrow"`
- maker
- seed

---

### 4. `#[program]` 模块

```rust
#[program]
pub mod agent_escrow {
    use super::*;
```

解释：

- `#[program]` 告诉 Anchor，这里定义的是链上指令入口
- `use super::*` 让模块内部可以访问外部定义的账户结构、错误码、工具函数

在这个模块里定义的函数：

- `make`
- `confirm_delivery`
- `check_and_execute`

都会被 Anchor 编译成链上可调用的 instruction entrypoint。

---

## 二、`make` 函数逐段讲解

```rust
pub fn make(ctx: Context<Make>, seed: u64, amount: u64, deadline: i64) -> Result<()> {
```

参数说明：

- `ctx`
  - 里面装的是这条指令需要的所有账户
  - 账户结构定义在后面的 `Make<'info>`
- `seed`
  - 用来参与 PDA 推导
- `amount`
  - 链上 raw amount，不是前端的小数字符串
- `deadline`
  - unix timestamp，秒

---

```rust
require!(amount > 0, EscrowError::InvalidAmount);
```

解释：

- 确保金额大于 0
- 不允许创建“锁 0 个 token”的 escrow

为什么要早检查：

- 越早失败越省 CU
- 也避免后面初始化账户、创建 vault 后才发现输入无效

---

```rust
let now = Clock::get()?.unix_timestamp;
require!(deadline > now, EscrowError::InvalidDeadline);
```

解释：

- 读取当前链上时间
- 检查 deadline 必须在未来

注意这里不是前端本地时间，而是：

- validator / cluster 的链上时钟

这能避免本地浏览器时间不准导致的业务歧义。

---

```rust
let escrow = &mut ctx.accounts.escrow;
escrow.maker = ctx.accounts.maker.key();
escrow.receiver = ctx.accounts.receiver.key();
escrow.verifier = ctx.accounts.verifier.key();
escrow.mint = ctx.accounts.mint.key();
escrow.amount = amount;
escrow.deadline = deadline;
escrow.confirmed = false;
escrow.executed = false;
escrow.seed = seed;
escrow.bump = ctx.bumps.escrow;
```

逐段解释：

- `let escrow = &mut ctx.accounts.escrow;`
  - 取出刚初始化好的 escrow 账户，准备写字段
- `maker / receiver / verifier / mint`
  - 把当前交易上下文中的核心角色和资产写进状态
- `amount / deadline`
  - 写业务条件
- `confirmed = false`
  - 初始必须未确认
- `executed = false`
  - 初始必须未结算
- `seed`
  - 把用户原始 seed 存下来，后面 execute 时恢复 signer seeds 要用
- `bump = ctx.bumps.escrow`
  - 由 Anchor 自动求得的 bump，必须存起来给后续 PDA signer 使用

这里的设计重点：

- escrow 账户本身就是整笔业务的“不可篡改规则快照”

---

```rust
token::transfer_checked(
    CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        TransferChecked {
            from: ctx.accounts.maker_token_account.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.maker.to_account_info(),
        },
    ),
    amount,
    ctx.accounts.mint.decimals,
)
```

这是 `make` 的资金动作。

逐项解释：

- `token::transfer_checked`
  - 调用 SPL Token Program 的 CPI
- `from`
  - maker 的 token account
- `mint`
  - 当前 escrow 对应的 mint
- `to`
  - vault
- `authority`
  - maker，因为 maker 正在把自己的钱转进 vault
- `amount`
  - raw amount
- `ctx.accounts.mint.decimals`
  - 由 mint 账户真实读取，确保 decimals 匹配

为什么是 `transfer_checked` 而不是 `transfer`：

- 可以让 token program 帮你校验 mint decimals
- 更安全，也更符合你的需求

执行结果：

- maker token account 减少
- vault 增加
- escrow 状态已经保存

---

## 三、`confirm_delivery` 逐段讲解

```rust
pub fn confirm_delivery(ctx: Context<ConfirmDelivery>) -> Result<()> {
```

这条指令不移动资金，它只改变状态。

---

```rust
require!(
    !ctx.accounts.escrow.executed,
    EscrowError::AlreadyExecuted
);
```

解释：

- 已经执行完成的 escrow 不允许再确认
- 因为结算已经结束，再修改确认状态就没有业务意义

---

```rust
require_keys_eq!(
    ctx.accounts.verifier.key(),
    ctx.accounts.escrow.verifier,
    EscrowError::UnauthorizedVerifier
);
```

解释：

- 这里不是只看“verifier 是 signer”
- 而是看“当前 signer 的地址，是否等于 escrow 里事先写死的 verifier”

这一步是整个 confirm 权限控制的核心。

---

```rust
ctx.accounts.escrow.confirmed = true;
Ok(())
```

解释：

- 状态变化只有一个：`confirmed = true`
- 没有 token movement
- 没有 close account

也就是说：

- confirm 只是把 escrow 从 `NotReady` 推到 `Confirmed`
- 还没有真正放款

---

## 四、`check_and_execute` 逐段讲解

```rust
pub fn check_and_execute(ctx: Context<CheckAndExecute>) -> Result<()> {
```

这是整个项目最关键的函数。

它负责：

- 判断当前是 release / refund / not ready
- 用 PDA 签名把 vault 里的钱打给正确目标
- 标记 executed
- 关闭 vault

---

```rust
require!(
    !ctx.accounts.escrow.executed,
    EscrowError::AlreadyExecuted
);
```

解释：

- 同一笔 escrow 只能执行一次
- 这是防重复结算的第一层保护

---

```rust
let now = Clock::get()?.unix_timestamp;
let destination = if ctx.accounts.escrow.confirmed {
    ctx.accounts.receiver_token_account.to_account_info()
} else if now > ctx.accounts.escrow.deadline {
    ctx.accounts.maker_token_account.to_account_info()
} else {
    return err!(EscrowError::NotReady);
};
```

这段是本项目的决策引擎。

逻辑展开：

1. 如果 `confirmed == true`
   - 钱给 receiver
2. 否则，如果当前时间已经大于 deadline
   - 钱退回 maker
3. 否则
   - 报错 `NotReady`

这里非常重要的一点：

- `caller` 完全没有参与 destination 决策
- 调用者只触发，不裁决

这就是“permissionless execution, deterministic decision”的真正落点。

---

```rust
let maker_key = ctx.accounts.escrow.maker;
let seed_bytes = ctx.accounts.escrow.seed.to_le_bytes();
let bump = [ctx.accounts.escrow.bump];
let escrow_signer_seeds: &[&[u8]] = &[
    ESCROW_SEED_PREFIX,
    maker_key.as_ref(),
    seed_bytes.as_ref(),
    bump.as_ref(),
];
let signer_seeds = &[escrow_signer_seeds];
```

解释：

- 这段是在恢复 escrow PDA 的 signer seeds
- 因为 vault 的 authority 是 escrow PDA
- 现在要从 vault 转账，就必须让程序“代表 escrow PDA”签名

为什么从状态里读取：

- `maker`
- `seed`
- `bump`

因为这三个值决定了 escrow PDA 的原始推导路径。

---

```rust
token::transfer_checked(
    CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        TransferChecked {
            from: ctx.accounts.vault.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: destination,
            authority: ctx.accounts.escrow.to_account_info(),
        },
        signer_seeds,
    ),
    ctx.accounts.escrow.amount,
    ctx.accounts.mint.decimals,
)?;
```

这是 execute 的真正放款 / 退款动作。

逐项解释：

- `new_with_signer`
  - 和 `make` 的不同点在这里
  - 这里不是 maker 自己签名，而是 PDA 签名
- `from = vault`
  - 钱从 vault 出去
- `to = destination`
  - destination 已经在前面分支判定完成
- `authority = escrow`
  - vault 的拥有者是 escrow PDA
- `signer_seeds`
  - 让 token program 接受这个 PDA 作为合法签名者
- `amount = escrow.amount`
  - 使用 escrow 状态里锁定的原始金额
- `mint.decimals`
  - 继续做 checked transfer

这个时点之后，token 已经被结算出去。

---

```rust
ctx.accounts.escrow.executed = true;
```

解释：

- 只有转账成功后，才把 executed 改成 true
- 顺序很重要

如果把这句写在前面，万一转账失败：

- 状态会错乱
- 资金还在 vault，但 escrow 被标成已执行

你现在这份代码顺序是正确的。

---

```rust
token::close_account(CpiContext::new_with_signer(
    ctx.accounts.token_program.to_account_info(),
    CloseAccount {
        account: ctx.accounts.vault.to_account_info(),
        destination: ctx.accounts.maker.to_account_info(),
        authority: ctx.accounts.escrow.to_account_info(),
    },
    signer_seeds,
))
```

解释：

- vault 里的 token 已经被转走
- 现在关闭 vault，把 rent 退给 maker

为什么退给 maker：

- maker 是初始化 escrow / vault 的 payer
- 这份实现里 rent 归还逻辑清晰简单

---

## 五、账户结构逐段讲解

### `Make<'info>`

```rust
#[derive(Accounts)]
#[instruction(seed: u64)]
pub struct Make<'info> {
```

解释：

- `#[derive(Accounts)]`
  - 告诉 Anchor 这是一组 instruction accounts
- `#[instruction(seed: u64)]`
  - 允许下面的 account constraint 里直接访问入参 `seed`

---

```rust
#[account(mut)]
pub maker: Signer<'info>,
```

解释：

- maker 要签名
- maker 要付 rent
- maker 的 token account 会被扣钱
- 所以必须是 `mut + Signer`

---

```rust
pub receiver: UncheckedAccount<'info>,
pub verifier: UncheckedAccount<'info>,
```

为什么是 `UncheckedAccount`：

- 这里只需要保存公钥
- 在 `make` 阶段不需要它们签名
- 也不需要它们是某种特定链上 data account

这是合理的，不是偷懒。

---

```rust
pub mint: Account<'info, Mint>,
```

解释：

- mint 必须真的是一个 SPL Mint 账户
- 后面转账和 decimals 读取都依赖这个约束

---

```rust
#[account(
    mut,
    associated_token::mint = mint,
    associated_token::authority = maker,
    associated_token::token_program = token_program
)]
pub maker_token_account: Account<'info, TokenAccount>,
```

解释：

- 这个账户必须是 maker 对当前 mint 的 ATA
- 不是任意 token account
- 这样能避免从错误账户扣款

---

```rust
#[account(
    init,
    payer = maker,
    space = 8 + Escrow::INIT_SPACE,
    seeds = [ESCROW_SEED_PREFIX, maker.key().as_ref(), &seed.to_le_bytes()],
    bump
)]
pub escrow: Account<'info, Escrow>,
```

解释：

- `init`
  - 创建新账户
- `payer = maker`
  - maker 支付租金
- `space = 8 + Escrow::INIT_SPACE`
  - `8` 是 Anchor 账户 discriminator
  - 后面是实际字段空间
- `seeds = [...]`
  - PDA 推导规则
- `bump`
  - 由 Anchor 自动计算并保存到 `ctx.bumps`

---

```rust
#[account(
    init,
    payer = maker,
    associated_token::mint = mint,
    associated_token::authority = escrow,
    associated_token::token_program = token_program
)]
pub vault: Account<'info, TokenAccount>,
```

解释：

- 初始化 vault
- 这个 vault 必须是：
  - escrow PDA 对当前 mint 的 ATA

这就是项目中“PDA-controlled vault”的具体实现。

---

### `ConfirmDelivery<'info>`

```rust
#[account(
    mut,
    seeds = [ESCROW_SEED_PREFIX, escrow.maker.as_ref(), &escrow.seed.to_le_bytes()],
    bump = escrow.bump
)]
pub escrow: Account<'info, Escrow>,
```

解释：

- confirm 时重新校验传进来的 escrow 确实是按原始规则推导出来的那个 PDA
- 不是任意一个长得像 escrow 的账户

---

### `CheckAndExecute<'info>`

```rust
pub caller: Signer<'info>,
```

解释：

- 任何人都可以做这个 signer
- 它的存在只是为了“发起这次交易”

---

```rust
#[account(
    mut,
    seeds = [ESCROW_SEED_PREFIX, escrow.maker.as_ref(), &escrow.seed.to_le_bytes()],
    bump = escrow.bump,
    has_one = mint
)]
pub escrow: Account<'info, Escrow>,
```

解释：

- PDA 必须匹配
- `has_one = mint`
  - escrow.mint 必须等于传进来的 mint 账户

这是防止 execute 时换 mint 的重要约束。

---

```rust
#[account(mut, address = escrow.maker)]
pub maker: UncheckedAccount<'info>,
```

解释：

- maker 地址必须和 escrow 状态里记录的一致
- 因为退款和 rent 返还都会用到它

---

```rust
#[account(address = escrow.receiver)]
pub receiver: UncheckedAccount<'info>,
```

解释：

- receiver 必须和 escrow 状态一致
- 防止调用者自己塞一个假 receiver

---

```rust
#[account(
    mut,
    associated_token::mint = mint,
    associated_token::authority = maker,
    associated_token::token_program = token_program
)]
pub maker_token_account: Account<'info, TokenAccount>,
```

解释：

- maker 收退款时，必须收进属于自己且匹配当前 mint 的 ATA

---

```rust
#[account(
    mut,
    associated_token::mint = mint,
    associated_token::authority = receiver,
    associated_token::token_program = token_program
)]
pub receiver_token_account: Account<'info, TokenAccount>,
```

解释：

- receiver 收款时，也必须是它自己的当前 mint ATA

---

```rust
#[account(
    mut,
    constraint = escrow.executed || vault.key() == associated_token_address(...) @ EscrowError::InvalidVault,
    constraint = escrow.executed || token_account_matches(...) @ EscrowError::InvalidVault
)]
pub vault: UncheckedAccount<'info>,
```

这是整个账户校验里最细的一段。

为什么 vault 这里不是 `Account<TokenAccount>`：

- 因为 repeated execute 场景下 vault 可能已经被关闭
- 如果直接强行反序列化成 `TokenAccount`，第二次 execute 时会更早炸掉
- 但你希望先由 handler 返回 `AlreadyExecuted`

所以这里的策略是：

- 用 `UncheckedAccount`
- 再手写两个 constraint 自己校验 vault 正确性

两个 constraint 的意义：

1. vault 地址必须等于 escrow PDA 对 mint 的 ATA
2. vault 数据里记录的 mint 和 owner 也必须匹配

并且：

- 如果 `escrow.executed == true`
- 则允许 vault 已经关闭，不强行校验

这是一个很实用、也比较稳的写法。

---

## 六、状态结构和空间计算

### `Escrow`

```rust
pub struct Escrow {
    pub maker: Pubkey,
    pub receiver: Pubkey,
    pub verifier: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub deadline: i64,
    pub confirmed: bool,
    pub executed: bool,
    pub seed: u64,
    pub bump: u8,
}
```

字段含义你已经在前一份文档里有了，这里重点补一句：

- `amount` 永远是 raw units
- 它是前端和链上最需要统一认知的字段

---

```rust
impl Escrow {
    pub const INIT_SPACE: usize = 32 + 32 + 32 + 32 + 8 + 8 + 1 + 1 + 8 + 1;
}
```

逐项拆开：

- 4 个 `Pubkey` = `32 * 4`
- `amount: u64` = `8`
- `deadline: i64` = `8`
- `confirmed: bool` = `1`
- `executed: bool` = `1`
- `seed: u64` = `8`
- `bump: u8` = `1`

总和：

- `123`

外部 `space = 8 + INIT_SPACE`

这里的 `8` 是 Anchor discriminator。

---

## 七、错误码

```rust
#[error_code]
pub enum EscrowError {
```

Anchor 会给这里每个错误分配自增 code。

前端之所以能把 `0x1772` 这种错误翻成 `NotReady` 相关提示，就是依赖这部分逻辑语义。

---

## 八、工具函数

### `associated_token_address(...)`

作用：

- 手动推导某 owner + mint 的 ATA 地址

为什么不用前端现成的 helper：

- 这是链上 Rust 代码
- 需要在 program 里自己计算

---

### `token_account_matches(...)`

作用：

- 手动读一个 token account 的底层数据
- 检查它的：
  - owner program 是否是 SPL Token Program
  - mint 是否匹配
  - token authority 是否匹配

为什么需要这段：

- 因为 `vault` 用的是 `UncheckedAccount`
- 你还是得补上真实性校验

这段代码的角色就是：

- 把 `UncheckedAccount` 的风险重新收回来

---

## 九、前端核心工具文件逐段讲解

### `app/src/lib/pda.ts`

文件：

- [app/src/lib/pda.ts](/home/don/codexAgentEscrow/app/src/lib/pda.ts)

#### `ESCROW_SEED_PREFIX`

- 和链上 Rust 保持一致
- 必须同样是 `"escrow"`

#### `toSeedBuffer(seed)`

- 把 `bigint` 转成 8 字节 little-endian
- 必须和 Rust 里的 `to_le_bytes()` 一致

#### `findEscrowPda(...)`

- 前端 / 测试推导 escrow PDA 的统一入口

#### `findVaultAddress(...)`

- 前端 / 测试推导 vault ATA 的统一入口

---

### `app/src/lib/token.ts`

这个文件主要是“前端里的 token 小工具层”。

#### `getOrCreateAtaInstruction(...)`

- 查 ATA 是否存在
- 不存在就返回创建 ATA 的 transaction

#### `getTokenBalance(...)`

- 安全读取 token 余额
- 如果账户不存在，返回 `0n`

#### `getMintDecimals(...)`

- 读取 mint decimals

#### `formatTokenAmount(...)`

- raw -> 人类可读小数字符串

#### `parseTokenAmount(...)`

- 人类可读输入 -> raw
- 这就是前端金额统一的关键函数

#### `buildCreateMintTransaction(...)`

- 构造一个 transaction：
  1. 创建 mint account
  2. 初始化 mint

#### `buildMintToWalletTransaction(...)`

- 如果 ATA 不存在，先塞 ATA 创建指令
- 然后塞 mintTo 指令

---

### `app/src/lib/anchor.ts`

这个文件负责把 wallet adapter 和 Anchor `Program` client 接起来。

#### `PROGRAM_ID`

- 从前端 IDL 里读出来

#### `readonlyWallet`

- 用一个临时 keypair 做只读 provider
- 这样即便没连钱包，也可以做 `fetch`

#### `createAnchorProvider(...)`

- 统一 commitment 配置

#### `getProgram(...)`

- 有连接钱包时，拿可签名 provider

#### `getReadonlyProgram(...)`

- 没连接钱包时，也能查 escrow 状态

---

## 十、组件逐段讲解

### `CreateEscrowForm.tsx`

它负责：

- 管输入
- 做最基础的前端校验
- 把结果交给 `App.tsx`

关键点：

- `defaultDeadline()`
  - 默认给 1 小时后的本地时间
- `seed` 初始自动填 `Date.now().toString()`
- `handleSubmit`
  - 校验公钥格式
  - 校验 amount > 0
  - 校验 seed 非空
  - 最后调用 `onSubmit(...)`

它不自己发交易。

它只是表单层。

---

### `ConfirmButton.tsx`

很薄的一层组件。

作用：

- 展示说明
- 展示 hint
- 在可用时触发 `onClick`

业务判断不在它这里。

业务判断在 `App.tsx`：

- 当前钱包是否就是 verifier
- escrow 是否已执行

---

### `ExecuteButton.tsx`

同样是一个展示层组件。

它有一行非常重要的文案：

- `Anyone can execute, but the contract decides the result.`

这行文案不是装饰，是整个项目逻辑的摘要。

---

### `EscrowStatus.tsx`

职责：

- 输入 escrow PDA
- 点击加载
- 展示 recent escrows
- 展示当前 escrow 的所有重要字段和余额

这个组件也不自己发链上查询，它调用父组件传进来的 `onLoad()`。

---

## 十一、`App.tsx` 逐段讲解

文件：

- [app/src/App.tsx](/home/don/codexAgentEscrow/app/src/App.tsx)

这个文件太大，所以这里只按“逻辑区块”讲，不机械地逐行抄。

### 顶部纯函数

#### `formatDeadline`

- 把链上秒级时间戳转成浏览器可读时间

#### `getExplorerLink`

- localnet 时不返回 Explorer 链接
- devnet 时生成 Explorer 地址

#### `deriveStatus`

- 前端根据：
  - confirmed
  - executed
  - deadline
- 推出 UI 状态：
  - Released
  - Refunded
  - Confirmed
  - Refundable
  - NotReady

#### `deriveExecutionHint`

- 给 Execute 区域提供更细的人话提示

#### `formatUiError`

- 把链上错误、钱包错误、网络错误翻译成更友好的提示

这层很关键，因为用户不应该直接看底层错误栈。

---

### React state

这部分是整个前端页面的内存模型。

最重要的几个：

- `currentEscrow`
  - 当前加载出来的 escrow
- `message`
  - 结果提示
- `signature`
  - 最近交易签名
- `transactionStage`
  - 当前交易阶段提示
- `devMint`
  - 当前测试 mint
- `devMintDecimals`
  - 当前 mint decimals
- `recentEscrows`
  - 本地浏览器存的最近 escrow 列表

---

### `rememberEscrow`

作用：

- 把最近加载 / 创建过的 escrow 记录进 localStorage

策略：

- 相同 escrow 去重
- 新的放最前
- 最多保留 8 条

---

### `submitTransaction`

这是前端交易提交总线。

它统一做：

1. 设置 blockhash
2. 设置 fee payer
3. extra signer partial sign
4. 钱包签名
5. 发 raw transaction
6. 等待确认
7. 设置交易阶段提示

这个函数的价值在于：

- 所有交易都走同一路径
- 行为可预期

---

### `refreshBalance`

作用：

- 读取当前钱包对当前 mint 的 ATA 余额
- 显示成：
  - `x tokens (y raw)`

它内部会：

1. 读取 mint decimals
2. 推导当前钱包 ATA
3. 读取余额
4. 做格式化

---

### `loadEscrowState`

作用：

- 给 Escrow Status 面板提供完整数据

它内部做的事很多：

1. 选只读 program 或可签名 program
2. 根据 escrow PDA 拉链上账户
3. 读 mint decimals
4. 算 vault
5. 算 maker ATA / receiver ATA
6. 拉三个余额
7. 生成当前 UI 状态
8. 写入 currentEscrow
9. 写 recent escrows

---

### `handleCreateEscrow`

逻辑链：

1. 检查钱包连接
2. 把 receiver / verifier / mint string 转 `PublicKey`
3. 读 mint decimals
4. 用 `parseTokenAmount` 把用户输入 amount 转成 raw
5. 把 deadline datetime 转成 unix seconds
6. 计算 escrow PDA
7. 确保 maker ATA 存在
8. 调 Anchor `make(...).transaction()`
9. 交给 `submitTransaction(...)`
10. 成功后刷新余额
11. 成功后自动加载 escrow 状态

---

### `handleConfirm`

逻辑链：

1. 检查当前已加载 escrow
2. 构造 `confirmDelivery().transaction()`
3. 交给 `submitTransaction(...)`
4. 成功后重新 load escrow

---

### `handleExecute`

逻辑链：

1. 先 fetch 最新 escrow
2. 如果已执行，直接前端提示并 return
3. 如果未确认且未超时，直接前端提示 `NotReady` 并 return
4. 确保 receiver ATA 存在
5. 构造 `checkAndExecute().transaction()`
6. 交给 `submitTransaction(...)`
7. 成功后根据 confirmed 决定提示 release 还是 refund
8. reload escrow

这就是你前面让修的那条 UX：

- 不要在明知 `NotReady` 时还弹钱包签名

---

## 十二、测试文件逐段讲解

文件：

- [tests/agent-escrow.ts](/home/don/codexAgentEscrow/tests/agent-escrow.ts)

### 顶部 helper

#### `findEscrowPda`

- 和前端、链上保持一致

#### `findVaultAddress`

- 推导 vault ATA

#### `airdrop`

- 给测试 keypair 充 SOL

#### `createAtaIfMissing`

- 确保测试用角色有对应 ATA

#### `sleep`

- 用于 refund path 等待 deadline 超时

#### `getEscrow`

- 从 program account 拉 escrow 状态

---

### `before(...)`

这里完成测试前准备：

1. 生成 verifier / outsider / receiver
2. 给它们打 SOL
3. 创建 mint
4. 创建 maker ATA / receiver ATA
5. 给 maker mint 足够多测试 token

这一步相当于搭好了整个测试沙盒。

---

### `release path`

验证目标：

- confirmed 后 execute，钱去 receiver

检查点：

- receiver 余额增加
- escrow.executed == true
- escrow.confirmed == true

---

### `refund path`

验证目标：

- 不 confirm，等超时，execute 后钱回 maker

检查点：

- maker 余额增加 amount
- receiver 余额不变
- escrow.executed == true
- escrow.confirmed == false

---

### `not ready`

验证目标：

- 未 confirm 且未超时时 execute 必须失败

---

### `unauthorized verifier`

验证目标：

- 错的人调用 confirm 必须失败

---

### `double execute`

验证目标：

- 第一次 execute 成功
- 第二次再 execute 必须失败

---

## 十三、你现在应该怎样带着这份文档读代码

推荐方法：

1. 一边看 [programs/agent_escrow/src/lib.rs](/home/don/codexAgentEscrow/programs/agent_escrow/src/lib.rs)，一边对照本文第一到第八部分
2. 再看 [app/src/App.tsx](/home/don/codexAgentEscrow/app/src/App.tsx)，重点对照第十一部分
3. 最后看 [tests/agent-escrow.ts](/home/don/codexAgentEscrow/tests/agent-escrow.ts)，确认每条业务路径如何被证明

这样你会更容易建立一个很稳的心智模型：

- 链上状态是什么
- 钱在哪里
- 前端怎么把用户输入变成链上参数
- execute 为什么开放但不危险
