# Market Dashboard — 你自己贴的代码片段

> 你说别动你的 HTML,所以这里只给代码 + 说明,你自己往 `market-dashboard.html` 里加。

## A. 去掉 Penang & Johor 的楼盘

在 `pull()` 里,拉回来、`RAW=arr.map(...)` **之后、`computeDeltas()` 之前**,加一行过滤:

```js
// 不看 Penang / Johor 的项目
const EXCLUDE_STATES = ["Penang", "Pulau Pinang", "Johor"];
RAW = RAW.filter(p => !EXCLUDE_STATES.includes((p.state || "").trim()));
```

- 注意 Penang 在数据里可能写成 `Penang` 或 `Pulau Pinang`,两个都挡了。
- 过滤后 KPI 的"154"会自动变成去掉这两州后的数量,州属下拉也不会再出现它们。

## B. 点某个项目 → 看更详细(项目级,已确认可用)

**详情接口**(已实测 200,返回该项目全字段):
```
GET https://app_api.property213.com/v22/accounts/{account}/projects/{ProjectUID}?appkey=…&token=…&userid=…
```
返回 `Result` 里是**单条**记录,含:`Project / DeveloperName / Tenure / LandTitle / PropertyType / PriceFrom / PriceTo / BuiltUpFrom / BuiltUpTo / TotalUnit / TotalBlock / ProjectStatus / Location / State / Area / Picture` 等。

代码(加在 `<script>` 里):
```js
function detailUrl(uid){
  const c = creds();
  const p = new URLSearchParams({ appkey:c.appkey, token:c.token, userid:c.userid });
  return `https://app_api.property213.com/v22/accounts/${c.account}/projects/${uid}?${p.toString()}`;
}

async function openDetail(uid){
  try{
    const j = await fetch(detailUrl(uid)).then(r=>r.json());
    const d = JSON.parse(j.Result)[0];
    alert(
      `${d.Project}\n`+
      `发展商:${d.DeveloperName || "—"}\n`+
      `价格(List):RM${d.PriceFrom} – ${d.PriceTo}\n`+
      `面积:${d.BuiltUpFrom} – ${d.BuiltUpTo} sqft\n`+
      `产权:${d.Tenure} / ${d.LandTitle}\n`+
      `类型:${d.PropertyType}\n`+
      `状态:${d.ProjectStatus}\n`+
      `总单位:${d.TotalUnit}  总栋数:${d.TotalBlock}\n`+
      `地点:${d.Location}`
    );
  }catch(e){ status("详情拉取失败,可能 token 过期。","warn"); }
}
```

让每行可点(在 `render()` 生成每个 `<tr>` 时,把开头改成带 `data-uid`):
```js
// 原来: return `<tr>
// 改成:
return `<tr data-uid="${p.uid}" style="cursor:pointer">
```
再在脚本里绑一次(整表用事件委托,一行就够):
```js
document.getElementById("rows").addEventListener("click", e=>{
  const tr = e.target.closest("tr[data-uid]");
  if(tr) openDetail(tr.dataset.uid);
});
```

> 想做成好看的侧边面板而不是 `alert`,把 `alert(...)` 换成往一个 `<div id="detail">` 里塞 HTML 即可,逻辑一样。

## C. 户型 / Unit Plan / 价格表 / package(还差一个接口)

App 里"Details → Unit Plan / Site Plan / 价格表"那些区块是**另一组接口**,我猜的名字(units/layout/package/pricechart…)都返回 404 或空。要给你**能用**的代码,必须在 App 里点一次 Unit Plan 把真实接口抓下来——我这次撞到使用上限没点完,**下次额度恢复我抓到就补给你**。

已知的线索:
- `.../projects/{uid}/units` 这个路径**存在**(返回 200),但我试的几个 pre-launch 项目是空 `[]`(可能还没上户型)。等抓到有户型的项目就能确认字段。
- 项目图片/sales kit 在 blob:`property213.blob.core.windows.net/…/saleskit/{id}/gallery/…` —— 户型图/价格表大概率是这类文件,由某个"files/gallery"接口列出,名字待抓。

---

一句话:**A(去 Penang/Johor)和 B(点进去看项目详情)现在就能用**;**C(layout/package)差一个接口,等我使用额度恢复再抓一次补齐。**
