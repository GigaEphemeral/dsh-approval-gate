/**
 * 验证一个 profile 的 loader 合成树：跨所有 bundle 层 + 用户层，
 * 检查 insert 型 row 的 id 是否有重复（重复 = 启动崩溃的根因），
 * 并确认 permission / dsh-approval-gate 两个关键 id 的插入次数。
 *
 * 用法（profile 可用 --profile 指定，默认 $DSH_HOME/profiles/web）：
 *   node .ag-test/verify-loader-tree.mjs
 *   node .ag-test/verify-loader-tree.mjs --profile <profile目录>
 * profile 不存在时打印 SKIP 并以 0 退出（不破坏无 DSH 安装的裸克隆 npm test）。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const args = process.argv.slice(2)
let profile = null
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--profile') profile = args[++i]
  else if (args[i].startsWith('--profile=')) profile = args[i].slice('--profile='.length)
}
profile = profile || join(DSH_HOME, 'profiles', 'web')
if (!existsSync(join(profile, 'package.json'))) {
  console.log(`SKIP: 未找到 profile ${profile}，跳过 loader 合成树校验`)
  process.exit(0)
}
// bundle 包可解析自 profile 自身 node_modules 或共享的 profiles/node_modules
const roots = [join(profile, 'node_modules'), join(dirname(profile), 'node_modules')]
const pkg = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
const bundles = pkg.dsh.profile.bundles

const layers = []
for (const b of bundles) {
  let found = null
  for (const r of roots) {
    const dir = join(r, b)
    if (existsSync(join(dir, 'package.json'))) { found = dir; break }
  }
  if (!found) { console.error(`未找到 bundle: ${b}`); process.exit(2) }
  const bp = JSON.parse(readFileSync(join(found, 'package.json'), 'utf8'))
  const patch = bp.dsh?.bundle?.patch
  if (!patch) { console.error(`${b} 未声明 dsh.bundle.patch`); process.exit(2) }
  layers.push({ label: b, path: join(found, patch) })
}
layers.push({ label: '(用户层) profile/cordis.patch.yml', path: join(profile, 'cordis.patch.yml') })

/** 解析一个 patch 文件顶层 entries，返回 { insertIds: string[], patchIds: string[] } */
function parse(text) {
  const lines = text.split('\n')
  const insertIds = []
  const patchIds = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^\s*#/.test(line) || line.trim() === '') { i++; continue }
    // 顶层 `- insert:` 简写：子项为缩进 ≥2 且以 `- ` 开头的行
    if (/^- insert:\s*$/.test(line)) {
      let j = i + 1
      while (j < lines.length) {
        const cl = lines[j]
        if (/^\s*#/.test(cl) || cl.trim() === '') { j++; continue }
        if (/^\s{2,}-\s/.test(cl)) {
          const idm = cl.match(/^\s*-\s+id:\s*(\S+)/)
          if (idm) insertIds.push(idm[1])
          j++
        } else if (/^\s+\S/.test(cl)) { j++ } // 子项属性行
        else break
      }
      i = j
      continue
    }
    // 顶层 `- id: <x>`（可能是 id-targeted patch，也可能带 insert: 键）
    const gm = line.match(/^- id:\s*(\S+)/)
    if (gm) {
      const gid = gm[1]
      let j = i + 1
      let hasInsert = false
      while (j < lines.length) {
        const cl = lines[j]
        if (/^\s*#/.test(cl) || cl.trim() === '') { j++; continue }
        if (/^\s+insert:\s*$/.test(cl)) {
          hasInsert = true
          let k = j + 1
          while (k < lines.length) {
            const c2 = lines[k]
            if (/^\s*#/.test(c2) || c2.trim() === '') { k++; continue }
            if (/^\s{4,}-\s/.test(c2)) {
              const idm2 = c2.match(/^\s*-\s+id:\s*(\S+)/)
              if (idm2) insertIds.push(idm2[1])
              k++
            } else if (/^\s+\S/.test(c2)) { k++ }
            else break
          }
          j = k
          break
        }
        if (/^\s+\S/.test(cl)) { j++; continue }
        break
      }
      i = j
      if (!hasInsert) patchIds.push(gid)
      continue
    }
    i++
  }
  return { insertIds, patchIds }
}

const all = new Map() // id -> [{layer, kind}]
let ok = true
for (const layer of layers) {
  const text = readFileSync(layer.path, 'utf8')
  const { insertIds, patchIds } = parse(text)
  console.log(`[${layer.label}] insert=${JSON.stringify(insertIds)} id-patch=${JSON.stringify(patchIds)}`)
  for (const id of insertIds) {
    if (!all.has(id)) all.set(id, [])
    all.get(id).push({ layer: layer.label, kind: 'insert' })
  }
  for (const id of patchIds) {
    if (!all.has(id)) all.set(id, [])
    all.get(id).push({ layer: layer.label, kind: 'id-patch' })
  }
}
console.log('--- 关键 id 检查 ---')
const check = (id) => {
  const hits = all.get(id) || []
  const inserts = hits.filter(h => h.kind === 'insert')
  console.log(`${id}: insert ×${inserts.length}（${inserts.map(h => h.layer).join(', ') || '无'}）；id-patch ×${hits.length - inserts.length}`)
  if (inserts.length > 1) { console.error(`  ✗ ${id} 被多个层 insert → 启动崩溃风险`); ok = false }
  if (inserts.length === 0) { console.error(`  ✗ ${id} 没有被任何层 insert`); ok = false }
}
check('permission')
check('dsh-approval-gate')
console.log('--- 重复 insert id 全量检查 ---')
for (const [id, hits] of all) {
  const inserts = hits.filter(h => h.kind === 'insert')
  if (inserts.length > 1) {
    console.error(`✗ insert id ${id} 重复：${inserts.map(h => h.layer).join(' | ')}`)
    ok = false
  }
}
console.log(ok ? 'RESULT: OK — 合成树无重复 insert id' : 'RESULT: CONFLICT')
process.exit(ok ? 0 : 1)
