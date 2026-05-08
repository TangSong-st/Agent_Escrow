# 从前端按钮到链上执行的完整调用链说明

这份文档专门回答一个问题：

**用户在页面上点一下按钮，代码内部到底发生了什么，最后又是怎样落到 Solana 链上的？**

它不是讲“字段含义”，而是讲“调用链”和“数据流”。

---

## 一、先看整条大图

```text
用户点击按钮
    |
    v
React 组件事件
    |
    v
App.tsx handler
    |
    +--> 前端校验 / 状态预检查
    |
    +--> PDA / ATA / amount / deadline 预处理
    |
    +--> Anchor Program method.transaction()
    |
    v
submitTransaction(...)
    |
    +--> wallet.signTransaction(...)
    +--> connection.sendRawTransaction(...)
    +--> connection.confirmTransaction(...)
    |
    v
Solana Runtime
    |
    v
Anchor Program (lib.rs)
    |
    +--> account constraints
    +--> 业务逻辑判断
    +--> SPL Token CPI
    |
    v
链上状态变化 / token 余额变化
    |
    v
前端重新 fetch 状态并更新 UI
```

---

## 二、页面里有哪些“入口按钮”

主要按钮在这些区域：

1. `Dev Token Helper`
   - `Create Dev Mint`
   - `Mint Test Token`
   - `Refresh Balance`
   - `Airdrop 2 SOL`
2. `Create Escrow`
   - 表单提交按钮
3. `Escrow Status`
   - `Load Escrow`
4. `Confirm Delivery`
   - `Confirm`
5. `Execute Settlement`
   - `Execute`

每个按钮本质上都对应 `App.tsx` 里的某个 handler。

---

## 三、Wallet 连接是怎么接上的

相关文件：

- [app/src/components/WalletProvider.tsx](/home/don/codexAgentEscrow/app/src/components/WalletProvider.tsx)
- [app/src/lib/anchor.ts](/home/don/codexAgentEscrow/app/src/lib/anchor.ts)
- [app/src/App.tsx](/home/don/codexAgentEscrow/app/src/App.tsx)

调用关系：

1. `WalletProvider.tsx`
   - 负责创建 Solana Connection 和 Wallet Adapter 上下文
2. `App.tsx`
   - 用 `useConnection()`
   - 用 `useWallet()`
   - 用 `useAnchorWallet()`
3. `anchor.ts`
   - 把 `connection + wallet` 包装成 `AnchorProvider`
   - 再构造 `Program<AgentEscrow>`

所以：

- 页面能读链上状态，靠的是 `connection`
- 页面能发交易，靠的是 `wallet`
- 页面能调 Anchor method，靠的是 `Program client`

---

## 四、Create Dev Mint 的调用链

按钮位置：

- `App.tsx` 的 `Dev Token Helper`

点击后触发：

- `handleCreateDevMint()`

### 调用链分解

#### 第 1 步：检查钱包

`handleCreateDevMint()` 先检查：

- `wallet.publicKey !== null`

如果没连钱包：

- 前端直接提示，不进后续流程

#### 第 2 步：构造 mint transaction

调用：

- `buildCreateMintTransaction(connection, wallet.publicKey, wallet.publicKey, 6)`

定义在：

- [app/src/lib/token.ts](/home/don/codexAgentEscrow/app/src/lib/token.ts)

内部做两件事：

1. `SystemProgram.createAccount(...)`
   - 创建 mint 账户
2. `createInitializeMintInstruction(...)`
   - 初始化 mint

返回：

- `mint: Keypair`
- `transaction: Transaction`

#### 第 3 步：提交交易

调用：

- `submitTransaction(transaction, [mint], labels)`

这里 `[mint]` 是额外 signer，因为：

- 新创建的 mint 账户本身也要签名

#### 第 4 步：钱包签名 + 广播 + 确认

`submitTransaction(...)` 做：

1. 拉 blockhash
2. 设 fee payer
3. `partialSign(mint)`
4. `wallet.signTransaction(...)`
5. `sendRawTransaction(...)`
6. `confirmTransaction(...)`

#### 第 5 步：前端状态更新

成功后：

- `setDevMint(mint.publicKey.toBase58())`
- `setDevMintDecimals(6)`
- `setSignature(...)`
- `setMessage(...)`
- `refreshBalance(...)`

这就是为什么页面上会立刻出现：

- 新的 mint 地址
- 新的提示弹窗

---

## 五、Mint Test Token 的调用链

按钮：

- `Mint Test Token`

触发：

- `handleMintToWallet()`

### 调用链分解

#### 第 1 步：检查条件

要求：

- 钱包已连接
- `devMint` 已存在

#### 第 2 步：把用户输入 amount 转成 raw

调用：

- `parseTokenAmount(devMintAmount, devMintDecimals ?? 0)`

例子：

- 输入 `1.5`
- decimals = `6`
- 转成 `1500000`

#### 第 3 步：构造 mintTo transaction

调用：

- `buildMintToWalletTransaction(...)`

内部做：

1. 检查钱包 ATA 是否存在
2. 不存在就先插入 ATA 创建 instruction
3. 再插入 `createMintToInstruction(...)`

#### 第 4 步：提交交易

调用：

- `submitTransaction(...)`

#### 第 5 步：刷新余额

成功后：

- `refreshBalance()`

页面显示会变成：

- `x tokens (y raw)`

---

## 六、Create Escrow 按钮的完整调用链

入口组件：

- [app/src/components/CreateEscrowForm.tsx](/home/don/codexAgentEscrow/app/src/components/CreateEscrowForm.tsx)

父组件：

- [app/src/App.tsx](/home/don/codexAgentEscrow/app/src/App.tsx)

---

### 1. 用户输入阶段

用户在表单中输入：

- receiver address
- verifier address
- mint address
- amount
- deadline
- seed

### 2. 表单层本地校验

`CreateEscrowForm.tsx` 的 `handleSubmit(...)` 做：

1. `new PublicKey(receiver)` 校验格式
2. `new PublicKey(verifier)` 校验格式
3. `new PublicKey(mint)` 校验格式
4. `Number(amount) > 0`
5. `seed` 非空

通过后：

- 调 `onSubmit(...)`

而这个 `onSubmit` 实际就是 `App.tsx` 里的 `handleCreateEscrow`

---

### 3. `handleCreateEscrow(...)` 内部链路

#### 第 1 步：把字符串转成链上参数

在 `App.tsx` 里做：

- `new PublicKey(input.receiver)`
- `new PublicKey(input.verifier)`
- `new PublicKey(input.mint)`

#### 第 2 步：读取 mint decimals

调用：

- `getMintDecimals(connection, mint)`

目的：

- 确认当前 token 有几位小数
- 后面做 amount 转换要用

#### 第 3 步：用户 amount -> 链上 raw amount

调用：

- `parseTokenAmount(input.amount, mintDecimals)`

例子：

- 用户输入 `2.5`
- mint decimals = `6`
- raw amount = `2500000`

#### 第 4 步：deadline 转换

调用：

- `new Date(input.deadline).getTime() / 1000`

结果：

- 得到 unix 秒级时间戳

#### 第 5 步：计算 escrow PDA

调用：

- `findEscrowPda(seed, wallet.publicKey, PROGRAM_ID)`

这一步前端和链上要完全一致：

- prefix = `"escrow"`
- maker = 当前钱包
- seed = little-endian 8 字节

#### 第 6 步：确保 maker ATA 存在

调用：

- `getOrCreateAtaInstruction(connection, wallet.publicKey, mint, wallet.publicKey)`

如果缺失：

- 先单独发一笔 ATA 创建交易

#### 第 7 步：构造 Anchor instruction transaction

调用：

```ts
program.methods
  .make(...)
  .accountsPartial({
    maker: wallet.publicKey,
    receiver,
    verifier,
    mint,
  })
  .transaction()
```

这里不是直接 `.rpc()`，而是先拿到 transaction，再走统一提交总线。

#### 第 8 步：统一提交

调用：

- `submitTransaction(transaction, [], labels)`

#### 第 9 步：链上真正发生什么

进入 program：

- `make(ctx, seed, amount, deadline)`

链上会：

1. 检查 amount > 0
2. 检查 deadline > now
3. 初始化 escrow PDA
4. 初始化 vault ATA
5. `transfer_checked`
6. maker token -> vault

#### 第 10 步：前端收尾

成功后：

- 保存 signature
- 保存 devMint
- 保存 decimals
- 设置 escrowPdaInput
- `rememberEscrow(...)`
- `refreshBalance(...)`
- `loadEscrowState(...)`

所以创建完成后，页面会立刻显示：

- escrow PDA
- 最近 escrow 列表
- 当前状态

---

## 七、Load Escrow 按钮的调用链

按钮位置：

- `EscrowStatus.tsx`

按钮点击时：

- 调用父组件传进来的 `onLoad`
- 实际是 `App.tsx` 的 `loadEscrowState()`

### `loadEscrowState()` 内部做什么

1. 读取当前输入的 escrow PDA
2. 如果已连 Anchor wallet，用 `getProgram`
3. 如果没连，用 `getReadonlyProgram`
4. `program.account.escrow.fetch(escrowPda)`
5. 读取 mint decimals
6. 推导 vault 地址
7. 推导 maker ATA
8. 推导 receiver ATA
9. 拉 maker / receiver / vault 余额
10. 用 `deriveStatus(...)` 算当前状态
11. 用 `deriveExecutionHint(...)` 算执行提示
12. 更新 `currentEscrow`
13. 写 recent escrow 到 localStorage

也就是说：

- `Load Escrow` 是一个纯查询链路
- 不需要钱包签名
- 不产生链上状态变化

---

## 八、Confirm 按钮的完整调用链

按钮组件：

- [app/src/components/ConfirmButton.tsx](/home/don/codexAgentEscrow/app/src/components/ConfirmButton.tsx)

真正逻辑入口：

- `App.tsx` 里的 `handleConfirm()`

### 1. 按钮能否点击

由 `App.tsx` 里的这组状态控制：

- `currentEscrow !== null`
- `wallet.publicKey !== null`
- 当前钱包地址必须等于 `currentEscrow.verifier`
- `currentEscrow.executed` 必须为 `false`

如果不满足：

- 按钮禁用
- hint 会提示为什么

### 2. `handleConfirm()` 内部流程

#### 第 1 步：构造 transaction

```ts
program.methods
  .confirmDelivery()
  .accountsPartial({
    escrow: new PublicKey(currentEscrow.escrowPda),
    verifier: wallet.publicKey,
  })
  .transaction()
```

#### 第 2 步：走统一提交

调用：

- `submitTransaction(transaction, [], labels)`

#### 第 3 步：链上真正发生什么

程序进入：

- `confirm_delivery(ctx)`

链上会：

1. 检查 `executed == false`
2. 检查 signer 是否等于 `escrow.verifier`
3. 设置 `confirmed = true`

#### 第 4 步：前端刷新

成功后：

- `setSignature(tx)`
- `setMessage("Delivery confirmed.")`
- `loadEscrowState(...)`

页面刷新后：

- Current State 应变成 `Confirmed`

---

## 九、Execute 按钮的完整调用链

按钮组件：

- [app/src/components/ExecuteButton.tsx](/home/don/codexAgentEscrow/app/src/components/ExecuteButton.tsx)

逻辑入口：

- `App.tsx` 的 `handleExecute()`

这是整个调用链里最复杂的一条。

---

### 1. 点击前的页面语义

按钮文案：

- `Anyone can execute, but the contract decides the result.`

它的意思是：

- 前端不限制调用者是谁
- 但最终结果仍由链上规则决定

---

### 2. `handleExecute()` 的前端预检查

#### 第 1 步：重新 fetch 最新 escrow

原因：

- 页面本地状态可能已经过期
- 先读最新链上状态再判断更稳

#### 第 2 步：如果已执行，直接 return

前端直接提示：

- `This escrow has already been executed.`

不进入签名。

#### 第 3 步：如果未 confirm 且未超时，直接 return

前端直接提示：

- `This escrow is not ready yet. It needs verifier confirmation or the deadline must pass first.`

这样用户不会白白签名。

这是纯前端 UX 优化。
真正的安全校验仍在链上。

---

### 3. 准备 execute 所需账户

#### 先取链上 escrow 的这几个字段

- mint
- maker
- receiver

#### 计算 receiver ATA

调用：

- `getOrCreateAtaInstruction(connection, wallet.publicKey, mint, receiver)`

如果 receiver ATA 不存在：

- 前端先发一笔单独的 ATA 创建交易

#### 计算 maker ATA / receiver ATA / vault

调用：

- `getAssociatedTokenAddressSync(...)`
- `findVaultAddress(...)`

这几步的目标是把 execute instruction 需要的所有账户都补齐。

---

### 4. 构造 execute transaction

```ts
program.methods
  .checkAndExecute()
  .accountsStrict({
    caller: wallet.publicKey,
    escrow: new PublicKey(currentEscrow.escrowPda),
    maker,
    receiver,
    mint,
    makerTokenAccount,
    receiverTokenAccount,
    tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    vault: findVaultAddress(...),
  })
  .transaction()
```

为什么这里用 `accountsStrict`：

- execute 所需账户较多
- 并且需要精准传递
- 这样更清晰，也更不容易依赖自动推导带来的歧义

---

### 5. 提交 execute transaction

调用：

- `submitTransaction(...)`

然后会经历：

1. 钱包签名
2. 发送 raw tx
3. 等链上确认

---

### 6. 链上 execute 真实发生什么

进入：

- `check_and_execute(ctx)`

链上流程：

1. 检查 `executed == false`
2. 读取 on-chain clock
3. 分支判断：
   - confirmed -> receiver
   - timeout -> maker
   - else -> `NotReady`
4. 恢复 escrow signer seeds
5. vault -> destination `transfer_checked`
6. `executed = true`
7. `close_account(vault)`
8. rent 返还 maker

---

### 7. 前端如何判断提示 release 还是 refund

`handleExecute()` 在执行成功后会根据刚刚 fetch 到的 escrow 状态判断：

- 如果 `escrow.confirmed == true`
  - 提示：released to receiver
- 否则
  - 提示：refunded to maker

然后：

- `loadEscrowState(...)`

重新拉链上数据，最终让 UI 显示：

- `Released`
  或
- `Refunded`

---

## 十、Recent Escrows 的调用链

你前面问过：

- 创建完 escrow 后还要自己记地址吗？

答案是不用，因为前端有 recent escrows 这条辅助链路。

### 写入时机

发生在：

- `handleCreateEscrow()` 成功后
- `loadEscrowState()` 成功后

### 写入函数

- `rememberEscrow(item)`

### 存储位置

- `window.localStorage`

key：

- `agent-escrow-recent-localnet`
  或
- `agent-escrow-recent-devnet`

### 页面展示

`EscrowStatus.tsx` 会把 recent escrows 渲染成按钮。

点击某一条 recent item：

- 调 `onSelectRecent(item.escrowPda)`
- 本质还是触发 `loadEscrowState(...)`

所以 recent escrows 本质上是“快捷查询入口”。

---

## 十一、错误提示调用链

错误最终要经过：

- `formatUiError(error, isLocalnet)`

这层会把：

- 钱包拒签
- `InvalidAmount`
- `InvalidDeadline`
- `NotReady`
- `UnauthorizedVerifier`
- `AlreadyExecuted`
- `InvalidVault`
- 余额不足
- 网络失败

转成更友好的文案。

也就是说完整链路是：

```text
底层抛错
   |
   v
catch(error)
   |
   v
formatUiError(error, isLocalnet)
   |
   v
setMessage(...)
   |
   v
弹窗显示
```

---

## 十二、弹窗提示调用链

当前前端已经把顶部 banner 改成弹窗。

显示逻辑大致是：

- `transactionStage !== null`
  - 显示处理中弹窗
- `message !== null || signature !== null`
  - 显示结果弹窗

对应链路：

```text
handler 开始
   |
   v
setTransactionStage("...")
   |
   v
modal 打开
   |
   v
交易成功/失败
   |
   +--> setMessage(...)
   +--> setSignature(...)
   +--> setTransactionStage(null)
   |
   v
结果弹窗展示
```

这样用户就能明确知道：

- 当前是在等签名
- 还是在等链上确认
- 还是已经成功 / 失败

---

## 十三、从前端到测试的映射关系

你可以把页面按钮和测试场景这样对应起来：

### 页面路径：Create -> Confirm -> Execute

对应测试：

- `release path`

### 页面路径：Create -> 等超时 -> Execute

对应测试：

- `refund path`

### 页面路径：Create -> 立即 Execute

对应测试：

- `not ready`

### 页面路径：错误 verifier 点 Confirm

对应测试：

- `unauthorized verifier`

### 页面路径：执行成功后再 Execute

对应测试：

- `double execute`

这有助于你从“代码能不能工作”切换到“我知道它为什么工作”。

---

## 十四、最后用一句话总结调用链

这个项目的调用链本质上是：

**按钮只触发前端 handler，handler 负责把用户输入转成链上可执行参数，Anchor Program 负责最终规则判断，SPL Token Program 负责实际转账，而前端最后再把链上结果拉回来展示。**
