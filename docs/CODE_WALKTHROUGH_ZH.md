# agent-escrow 代码详解文档

## 1. 项目到底在做什么

这个项目实现的是一个基于 Solana 的规则驱动托管结算系统。

它不是“谁调用 execute，钱就给谁”，而是：

- 钱先锁进链上的 SPL Token Vault
- Vault 的控制权属于程序 PDA
- 任何人都可以触发 `check_and_execute`
- 但资金最终去向完全由合约状态决定

规则只有三条：

1. `confirmed == true`，放款给 `receiver`
2. `confirmed == false` 且 `now > deadline`，退款给 `maker`
3. 否则报错 `NotReady`

所以这个项目最重要的一句话是：

**执行是开放的，结算是确定的。**

---

## 2. 项目目录与职责

### 链上程序

- [programs/agent_escrow/src/lib.rs](/home/don/codexAgentEscrow/programs/agent_escrow/src/lib.rs)

职责：

- 定义 Escrow 账户结构
- 定义 make / confirm / execute 三个核心指令
- 负责所有资金流向判断

### 测试

- [tests/agent-escrow.ts](/home/don/codexAgentEscrow/tests/agent-escrow.ts)

职责：

- 验证 release path
- 验证 refund path
- 验证 not ready
- 验证 unauthorized verifier
- 验证 double execute

### 自动化脚本

- [scripts/buyer-agent.ts](/home/don/codexAgentEscrow/scripts/buyer-agent.ts)
- [scripts/verifier-agent.ts](/home/don/codexAgentEscrow/scripts/verifier-agent.ts)
- [scripts/keeper-agent.ts](/home/don/codexAgentEscrow/scripts/keeper-agent.ts)

职责：

- 模拟 buyer / verifier / keeper 三种 agent 角色

### 前端

- [app/src/App.tsx](/home/don/codexAgentEscrow/app/src/App.tsx)
- [app/src/lib/anchor.ts](/home/don/codexAgentEscrow/app/src/lib/anchor.ts)
- [app/src/lib/pda.ts](/home/don/codexAgentEscrow/app/src/lib/pda.ts)
- [app/src/lib/token.ts](/home/don/codexAgentEscrow/app/src/lib/token.ts)
- [app/src/components/CreateEscrowForm.tsx](/home/don/codexAgentEscrow/app/src/components/CreateEscrowForm.tsx)
- [app/src/components/EscrowStatus.tsx](/home/don/codexAgentEscrow/app/src/components/EscrowStatus.tsx)

职责：

- 钱包连接
- 创建 escrow
- 查询 escrow
- confirm
- execute
- 本地测试 mint / mint token

---

## 3. 整体数据流

```text
Maker
  |
  | make()
  v
Escrow Account(PDA) -------------------------+
  |                                          |
  | authority                               |
  v                                          |
Vault Token Account(ATA of Escrow PDA)       |
  |                                          |
  | check_and_execute()                      |
  v                                          |
Receiver ATA  or  Maker ATA <----------------+
```

可以把它理解成两层：

### 第一层：规则层

规则存在 `Escrow` 账户里，字段包括：

- 谁是 maker
- 谁是 receiver
- 谁是 verifier
- 用什么 mint
- 金额多少
- 截止时间是什么时候
- 是否 confirmed
- 是否 executed

### 第二层：资金层

真正的 token 不存在 `Escrow` 账户里，而是存在 `vault` token account 里。

也就是说：

- `Escrow` 账户存“规则”
- `Vault` 账户存“钱”

---

## 4. Escrow 账户字段详解

定义在：

- [programs/agent_escrow/src/lib.rs](/home/don/codexAgentEscrow/programs/agent_escrow/src/lib.rs)

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

下面逐个解释。

### `maker`

含义：

- 创建 escrow 的人
- 原始出资人
- `make` 时的签名者
- vault 里的钱如果超时未确认，会退回给他
- vault 关闭时，rent 也返还给他

### `receiver`

含义：

- 最终收款目标
- 如果 verifier 确认成功，资金最终发给他

注意：

- receiver 只是一个公钥
- 不是在 `make` 时就直接收到钱
- 钱在 execute 前始终锁在 vault 里

### `verifier`

含义：

- 唯一有权限调用 `confirm_delivery()` 的地址
- 它控制的不是资金，而是“确认条件”

可以这样理解：

- verifier 不是收款人
- verifier 不是付款人
- verifier 是“这个交付是否已成立”的链上确认者

### `mint`

含义：

- 本次 escrow 锁定的是哪一个 SPL Token

它决定：

- maker token account 必须是这个 mint
- receiver token account 必须是这个 mint
- vault token account 也必须是这个 mint

### `amount`

这个字段非常关键。

它在链上存的是：

- **raw amount**
- 也就是 SPL Token 最小单位数量

举例：

如果 mint decimals = `6`

- 前端输入 `1`
- 代表 `1 token`
- 链上存的 `amount` 会是 `1000000`

如果前端输入 `2.5`

- 链上会存 `2500000`

所以这个项目现在统一规则是：

- 前端输入和展示：`token units`
- 链上存储：`raw units`

### `deadline`

含义：

- unix timestamp，单位是秒

它参与 refund 分支判断：

- 当前链上时间如果已经超过 deadline
- 且还没有 confirmed
- 就可以退款给 maker

### `confirmed`

含义：

- 是否已经被 verifier 确认

初始值：

- `false`

变化方式：

- 只有 `confirm_delivery()` 可以把它改成 `true`

用途：

- 决定 execute 是走 release 还是继续等待 / 超时退款

### `executed`

含义：

- 这个 escrow 是否已经结算完成

初始值：

- `false`

在这两种情况下变成 `true`：

1. 已 confirmed，执行放款给 receiver
2. 未 confirmed，但已超时，执行退款给 maker

用途：

- 防止重复 execute
- 防止结算后再 confirm

### `seed`

含义：

- 用户提供的一个 `u64`
- 用来参与 PDA 推导

用途：

- 同一个 maker 可以创建多个 escrow
- 通过不同 seed 区分它们

### `bump`

含义：

- Escrow PDA 的 bump

用途：

- 后续 `check_and_execute()` 时，程序需要用 PDA 签名
- bump 用于恢复 PDA signer seeds

---

## 5. PDA 与 Vault 是怎么设计的

### Escrow PDA

种子：

```text
["escrow", maker, seed]
```

精确来说是：

- `"escrow"`
- `maker.key().as_ref()`
- `seed.to_le_bytes()`

为什么这样设计：

1. maker 自己可以创建多个 escrow
2. 不同 seed 会得到不同 escrow PDA
3. 地址可预测，方便前端和脚本统一推导

### Vault Token Account

Vault 不是随便创建的普通 token account，而是：

- `owner = escrow PDA`
- `mint = escrow.mint`
- 并且使用关联 token account 规则推导出来

也就是说 vault 的本质是：

**Escrow PDA 对某个 mint 的 ATA**

这样做的好处：

- 地址稳定
- 方便校验
- 降低传错 vault 的风险

---

## 6. 钱到底存在哪里

这是最容易混淆的地方。

### 不是存在 Escrow 账户里

`Escrow` 账户只是普通程序账户，里面存的是元数据：

- maker
- receiver
- verifier
- mint
- amount
- deadline
- confirmed
- executed
- seed
- bump

它本身不存 SPL Token 余额。

### 真正的 token 存在 vault 里

vault 是 SPL Token Account。

里面存：

- 某个 mint 的 token 数量
- owner = escrow PDA

所以“资金锁仓”的本质是：

- maker 先把 token 转进 vault
- vault 的 owner 不是 maker，而是程序 PDA
- maker 无法自己再把钱转出来
- 只能通过程序规则结算

---

## 7. make 指令完整逻辑

函数：

- `make(seed: u64, amount: u64, deadline: i64)`

### 输入是什么

- `seed`
- `amount`
- `deadline`

### 账户是什么

- `maker`
- `receiver`
- `verifier`
- `mint`
- `maker_token_account`
- `escrow`
- `vault`
- `token_program`
- `associated_token_program`
- `system_program`
- `rent`

### 每一步逻辑

#### 第 1 步：检查 amount

要求：

- `amount > 0`

否则：

- 报错 `InvalidAmount`

#### 第 2 步：检查 deadline

要求：

- `deadline > 当前链上时间`

否则：

- 报错 `InvalidDeadline`

#### 第 3 步：初始化 Escrow PDA

程序会创建并初始化 escrow 账户。

这个账户用于保存整笔托管交易的规则。

#### 第 4 步：写入字段

程序把以下值写入 escrow：

- maker
- receiver
- verifier
- mint
- amount
- deadline
- confirmed = false
- executed = false
- seed
- bump

#### 第 5 步：初始化 Vault

程序创建 vault ATA：

- mint = 当前 mint
- authority = escrow PDA

#### 第 6 步：从 maker 转账到 vault

使用：

- `transfer_checked`

从：

- `maker_token_account`

转到：

- `vault`

数量：

- `amount`

这里的 `amount` 是 raw units，不是小数字符串。

### make 完成后状态

此时：

- maker 钱减少
- vault 钱增加
- `confirmed = false`
- `executed = false`

UI 上应该显示：

- `Current State = NotReady`

---

## 8. confirm_delivery 指令完整逻辑

函数：

- `confirm_delivery()`

### 谁可以调用

只有：

- `escrow.verifier`

### 每一步逻辑

#### 第 1 步：检查 escrow 是否已经 executed

如果已经结算过：

- 报错 `AlreadyExecuted`

#### 第 2 步：检查 signer 是否等于 verifier

如果不是：

- 报错 `UnauthorizedVerifier`

#### 第 3 步：设置 confirmed = true

不会发生 token 转账。

它只改变结算条件。

### confirm 完成后状态

此时：

- vault 里仍然有钱
- receiver 还没收到钱
- maker 也没退款
- 只是 escrow 进入“已确认，可放款”状态

UI 上应该显示：

- `Current State = Confirmed`

---

## 9. check_and_execute 指令完整逻辑

函数：

- `check_and_execute()`

### 谁可以调用

任何 signer 都可以。

这就是 permissionless execution。

但请注意：

调用者不是资金决策者。

### 账户是什么

- caller
- escrow
- maker
- receiver
- mint
- maker_token_account
- receiver_token_account
- vault
- token_program
- associated_token_program

### 每一步逻辑

#### 第 1 步：检查是否已执行

如果：

- `escrow.executed == true`

则：

- 报错 `AlreadyExecuted`

#### 第 2 步：读取当前链上时间

用 `Clock::get()?.unix_timestamp`

#### 第 3 步：判断应该走哪条分支

分支 1：

- 如果 `confirmed == true`
- 目标账户 = `receiver_token_account`

分支 2：

- 如果 `confirmed == false`
- 且 `now > deadline`
- 目标账户 = `maker_token_account`

分支 3：

- 如果上面两个都不满足
- 报错 `NotReady`

#### 第 4 步：恢复 PDA signer seeds

程序用：

- `"escrow"`
- maker
- seed
- bump

重新生成 signer seeds。

因为 vault 的 authority 是 escrow PDA，所以程序必须拿这组 seeds 来代表 PDA 签名。

#### 第 5 步：从 vault 转账到最终目标账户

还是使用：

- `transfer_checked`

如果是 confirmed path：

- vault -> receiver token account

如果是 refund path：

- vault -> maker token account

#### 第 6 步：设置 executed = true

防止重复执行。

#### 第 7 步：关闭 vault

调用 `close_account`

关闭后：

- vault 不再存在
- vault 的 rent 返还给 maker

### execute 后的最终结果

#### 如果是 confirmed path

最终应为：

- `confirmed = true`
- `executed = true`
- receiver 收到钱
- vault 余额为 0 并被关闭

UI 应显示：

- `Current State = Released`

#### 如果是 refund path

最终应为：

- `confirmed = false`
- `executed = true`
- maker 收回钱
- vault 余额为 0 并被关闭

UI 应显示：

- `Current State = Refunded`

---

## 10. 为什么任何人 execute 也偷不走钱

因为 execute 的调用者不是资金去向参数。

程序根本不会把钱转给 `caller`。

程序只会把钱转给这两个之一：

1. `receiver_token_account`
2. `maker_token_account`

而这两个账户都和 escrow 绑定：

- maker 必须等于 `escrow.maker`
- receiver 必须等于 `escrow.receiver`
- mint 必须匹配 `escrow.mint`

所以 caller 的身份不会改变资金归属。

caller 只做一件事：

- 触发程序按规则结算

---

## 11. 错误码每个是什么意思

### `InvalidAmount`

说明：

- make 时 amount <= 0

### `InvalidDeadline`

说明：

- make 时 deadline 没有晚于当前链上时间

### `NotReady`

说明：

- 还没 confirm
- 也还没超时
- execute 现在不能做

### `UnauthorizedVerifier`

说明：

- 不是 verifier 的钱包在调用 confirm

### `AlreadyExecuted`

说明：

- escrow 已经结算过
- 不能再次 confirm 或 execute

### `MathOverflow`

说明：

- 预留的数学溢出错误

### `InvalidVault`

说明：

- 提供的 vault 账户不是这个 escrow 对应的正确 vault

---

## 12. 前端里的 amount 是怎么统一的

这个问题是本项目最值得单独说清楚的一点。

### 统一规则

现在全项目前端统一为：

- 输入：token units
- 展示：token units + raw units
- 上链：raw units

### 举例

假设 mint decimals = `6`

#### 用户输入

- `1`

#### 前端转换

- `parseTokenAmount("1", 6)` -> `1000000`

#### 链上存储

- `amount = 1000000`

#### 页面展示

- `1 tokens`
- `1000000 raw`

### 这套逻辑写在哪里

文件：

- [app/src/lib/token.ts](/home/don/codexAgentEscrow/app/src/lib/token.ts)

函数：

- `parseTokenAmount`
- `formatTokenAmount`

### 为什么要这样设计

因为：

- 用户习惯输入 `1.5`
- 链上程序需要 `u64`
- 两边表示方式天然不同

所以前端负责做人类输入和链上 raw amount 之间的桥梁。

---

## 13. 前端 `App.tsx` 的职责

文件：

- [app/src/App.tsx](/home/don/codexAgentEscrow/app/src/App.tsx)

这是前端的总控文件。

它负责：

- 管理当前钱包状态
- 管理当前 mint
- 管理当前 escrow
- 管理最近访问的 escrow
- 管理交易阶段提示
- 管理错误提示
- 管理 token / SOL 余额刷新

### 重要状态变量

#### `escrowPdaInput`

- 当前输入框里的 escrow 地址

#### `currentEscrow`

- 当前从链上读取出来的 escrow 完整信息

#### `loadingAction`

- 当前哪一个动作正在进行
- 比如 create / confirm / execute / load

#### `message`

- 给用户看的主要结果提示

#### `signature`

- 最近一次交易签名

#### `transactionStage`

- 当前交易进行到哪一步
- 例如：
  - 等待钱包签名
  - 提交交易
  - 等待确认

#### `devMint`

- 当前页面里用于测试的 mint 地址

#### `devMintDecimals`

- 当前 mint 的 decimals

#### `recentEscrows`

- 最近加载或创建过的 escrow 列表
- 存在浏览器 localStorage 里

这就是你创建完 escrow 以后，不用自己死记硬背地址的原因。

---

## 14. 前端如何提交交易

核心函数：

- `submitTransaction(...)`

### 每一步做什么

1. 确保钱包已连接
2. 确保钱包支持签名
3. 拉取最新 blockhash
4. 设置 `feePayer`
5. 设置 `recentBlockhash`
6. 如果有额外 signer，先 partialSign
7. 弹钱包签名
8. `sendRawTransaction`
9. `confirmTransaction`

### 为什么自己写这层

因为不同钱包适配器对：

- `sendTransaction`
- Anchor `.rpc()`

兼容性并不总是稳定。

自己统一这层以后：

- Create Dev Mint
- Mint Test Token
- Create Escrow
- Confirm
- Execute

都能走同一套提交流程。

---

## 15. 前端如何查询 escrow

函数：

- `loadEscrowState(...)`

### 每一步逻辑

1. 用 escrow PDA 读取链上 escrow 账户
2. 读取 mint decimals
3. 推导 vault 地址
4. 推导 maker ATA
5. 推导 receiver ATA
6. 读取 maker balance
7. 读取 receiver balance
8. 读取 vault balance
9. 计算当前状态
10. 更新页面显示
11. 记录到 recent escrows

---

## 16. 当前状态是怎么计算的

现在前端状态统一为 5 种。

### `NotReady`

条件：

- `executed == false`
- `confirmed == false`
- `now <= deadline`

含义：

- 还不能 execute

### `Confirmed`

条件：

- `executed == false`
- `confirmed == true`

含义：

- 可以放款给 receiver

### `Refundable`

条件：

- `executed == false`
- `confirmed == false`
- `now > deadline`

含义：

- 可以退款给 maker

### `Released`

条件：

- `executed == true`
- `confirmed == true`

含义：

- 最终执行结果是放款

### `Refunded`

条件：

- `executed == true`
- `confirmed == false`

含义：

- 最终执行结果是退款

这就是为什么现在不能再用以前那个模糊状态：

- `Released/Refunded/Executed`

因为它没法告诉你最终到底发生了什么。

---

## 17. 前端为什么现在会拦截 NotReady execute

以前的问题是：

- 用户点 Execute
- 钱包弹签名
- 结果上链后才报 `NotReady`

这体验很差。

所以现在前端会先做一次预检查：

1. 先读 escrow
2. 如果已经 executed，直接提示
3. 如果未 confirm 且未超时，直接提示 `NotReady`
4. 不进入签名流程

注意：

这只是 UX 优化，不是安全边界。

真正的安全边界依然是链上程序。

---

## 18. 为什么你不需要手动记住 escrow 地址

前端现在会把 recent escrows 保存到浏览器 localStorage。

保存内容包括：

- escrow PDA
- mint
- 最近更新时间
- 最近一次状态

所以：

- 你 create 之后会自动记录
- 你 load 之后也会自动记录
- 下次刷新页面，只要还是这个浏览器环境，就还能看到 recent list

这部分的本质是：

- **链上存真实数据**
- **浏览器 localStorage 存你最近查过哪些地址**

---

## 19. token helper 层在做什么

文件：

- [app/src/lib/token.ts](/home/don/codexAgentEscrow/app/src/lib/token.ts)

### `getOrCreateAtaInstruction`

用途：

- 查某个 owner 对某个 mint 的 ATA 是否存在
- 如果不存在，返回创建 ATA 的 transaction

### `getTokenBalance`

用途：

- 安全读取 token account 余额
- 如果 token account 不存在，返回 `0n`

### `getMintDecimals`

用途：

- 读取 mint 的 decimals

### `formatTokenAmount`

用途：

- 把 raw amount 变成用户能看懂的 token 数量字符串

### `parseTokenAmount`

用途：

- 把用户输入的 `1.25`
- 变成链上需要的 `1250000`

---

## 20. 测试在验证什么

文件：

- [tests/agent-escrow.ts](/home/don/codexAgentEscrow/tests/agent-escrow.ts)

### release path

验证：

- confirm 后 execute，钱会去 receiver

### refund path

验证：

- 不 confirm，deadline 过后 execute，钱会退回 maker

### not ready

验证：

- 不 confirm 且没超时 execute，必须失败

### unauthorized verifier

验证：

- 非 verifier 调 confirm，必须失败

### double execute

验证：

- 成功执行一次后，第二次 execute 必须失败

这几条测试几乎覆盖了整个合约行为核心。

---

## 21. 三个 agent script 分别代表什么角色

### `buyer-agent.ts`

角色：

- 创建 escrow 的自动化脚本

### `verifier-agent.ts`

角色：

- 负责调用 confirm 的自动化脚本

### `keeper-agent.ts`

角色：

- 负责 permissionless execute 的自动化脚本

这也就是 README 里所说的：

**Agent 不是 AI，而是自动执行规则的机器人 / keeper / script。**

---

## 22. 一笔 escrow 从开始到结束的完整生命周期

### 阶段 1：创建

maker 发起 `make`

结果：

- escrow 账户被创建
- vault 被创建
- maker token -> vault

### 阶段 2A：确认

verifier 调 `confirm_delivery`

结果：

- `confirmed = true`

### 阶段 2B：未确认等待超时

如果不确认：

- `confirmed` 一直保持 `false`

### 阶段 3A：已确认后 execute

任何人可调用 `check_and_execute`

结果：

- vault -> receiver
- `executed = true`
- vault 关闭

### 阶段 3B：未确认但超时后 execute

任何人可调用 `check_and_execute`

结果：

- vault -> maker
- `executed = true`
- vault 关闭

### 阶段 3C：未确认且未超时就 execute

结果：

- 报错 `NotReady`
- 不发生资金变化

---

## 23. 这个设计为什么适合 agent

因为 agent 需要的是：

- 明确规则
- 可自动轮询
- 可自动执行
- 不依赖主观判断

比如 keeper 可以定时扫描：

- 哪些 escrow 已 confirmed 但还没 execute
- 哪些 escrow 已过 deadline 但还没 execute

然后自动调用 execute。

不需要人工一笔笔点按钮。

---

## 24. 这个设计为什么不适合纯线下模糊交易

因为链上只知道这些事实：

- 是否 confirm 了
- 是否超时了
- 当前时间是多少

它不知道：

- 货是不是坏了
- 快递是不是丢了
- 线下交付是不是存在争议

所以它适合：

- 可被明确规则表达的结算

不适合：

- 高度依赖主观仲裁的复杂线下交易

---

## 25. 建议你阅读代码的顺序

如果你想真正吃透这个项目，建议按这个顺序看：

1. [programs/agent_escrow/src/lib.rs](/home/don/codexAgentEscrow/programs/agent_escrow/src/lib.rs)
2. [tests/agent-escrow.ts](/home/don/codexAgentEscrow/tests/agent-escrow.ts)
3. [app/src/lib/token.ts](/home/don/codexAgentEscrow/app/src/lib/token.ts)
4. [app/src/App.tsx](/home/don/codexAgentEscrow/app/src/App.tsx)
5. [app/src/components/EscrowStatus.tsx](/home/don/codexAgentEscrow/app/src/components/EscrowStatus.tsx)
6. [scripts/keeper-agent.ts](/home/don/codexAgentEscrow/scripts/keeper-agent.ts)

原因是：

- 先看链上规则
- 再看测试如何验证规则
- 再看前端如何调用
- 最后看脚本如何自动化

---

## 26. 最后用一句话总结整个项目

这个项目的本质是：

**用 Escrow 账户保存规则，用 Vault 保存资金，用 Verifier 提供确认条件，用 Keeper 触发执行，但让资金最终流向永远由链上确定。**
