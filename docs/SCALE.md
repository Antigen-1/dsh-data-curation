# 规模化提交（0.16.0）

## 提交文件格式

`curation_submit({ channel, batch, from })` 和 `curation_job({ action:"start", from, ... })`
读取项目内相对路径，可以是一个文件，也可以是一个目录（合并其中的 `.csv`/`.jsonl`）。

### JSONL（支持证据）

```json
{"record_id":"CASE-1","status":"valid","values":{"location":"A区","note":"ok"},"evidence":{"location":{"page":1,"quote":"A区"}}}
```

也接受扁平对象：

```json
{"record_id":"CASE-1","location":"A区","note":"ok"}
```

扁平对象的 `record_id`/`status` 之外的所有键都作为 `values`；没有证据。`status` 缺省
`valid`，允许 `valid`/`uncertain`/`invalid`。

### CSV（无证据）

```csv
record_id,location,note
CASE-1,A区,ok
CASE-2,B区,
```

第一列/`record_id` 为键；`status` 可选；其余列都是字段值。CSV 不能表达证据，需要证据
时用 JSONL。同一文件内重复记录键会整批拒绝，避免最后一次静默覆盖前一次。

## 作业（curation_job）

`action: "start"` 把输入按 `chunkSize`（默认 200）分块提交，每块使用独立的批次名
`<batch>-c001`，避免同批次替换。每块结束后把 `offset/submitted/failed/errors` 写入
`.curation/jobs/<jobId>.json`：

- `completed`：全部块成功；
- `partial`：有失败但仍有成功记录；
- `failed`：失败达到上限，或全部块失败；
- `cancelled`：显式取消。

`status` / `list` 只读作业文件；`resume` 从 `offset` 继续，如果源文件记录数变化会拒绝
续跑；`cancel` 只标记状态，不中断已经返回的调用（作业是前台的，每次调用推进若干块）。

## 字段级状态

```text
curation_query({ what: "coverage", table: "summary" })
```

返回每张表的字段列表，每行：

- `submitted`：至少一个通道提交过非空值的记录数；
- `accepted`：最新一次比对的接受格数；
- `pending`：最新一次比对的待裁定格数。

它不替代 `curation_verify` 的门禁，只回答“哪些字段还没有人提交/还没有结论”。

## 边界

- 作业不是后台守护进程；进程退出后需要再次调用 `resume`。
- 单块失败会记录并继续，但如果失败是系统性契约错误（例如整块字段未声明），每个块都会
  失败，作业会到失败上限后停止。
- 作业不自动 compare/apply；提交完成后仍需按八阶段运行 `curation_compare` 等。
