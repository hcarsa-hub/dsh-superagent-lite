
/**
 * superagent-panel v33 — Client 半部：完成单行尾「归档」按钮底色改棕褐色 #5c4033（白字）。其余同 v32。
 *
 * v31 — Client 半部：工单页加「搜编号/标题/类型」；归档搜索也认类型词（测试/代码/办公）。其余同 v30。
 *
 * v30 — Client 半部：v29 + 修「工单表滚不动」：表格容器改成 flex:1 + minHeight:0 + overflow:auto，并给 calc 兜底高度（无论百分比能否解析都能滚）。
 *
 * 交互：
 *   - 进「工单」页：表格平铺整宽，右侧不留空
 *   - 点某一行：右侧才出现该工单的证据预览（Markdown 渲染，字号 12.5px），可点「收起」回到平铺
 *   - 定位：资源管理器选中证据文件
 * 只读：没有改状态的按钮。
 */
window.__ModuleLoader__.load({
  id: 'dsh-superagent-lite-panel',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useLayoutEffect } = React

    const PANEL_ID = 'superagent-panel'
    const POLL_MS = 1500
    // 面板顶部低调装饰底纹（GPT 图像模型生成，1200x400 JPEG，约 9KB，mix-blend-mode:screen 保证明暗主题都不突兀）
    const BANNER = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAHTBXgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDBJ+n5Uf56UpH8qMV83c92wA/T8qXP0/KgClxSuMb+X5Un5flT8UYouBH/AJ6Uh/D8qk20Yp3EQnPt+VNP4flU5WmlKaYWIefb8qaR9PyqXbSFadxWISPp+VRsD7flU5FMK1SYrEBB9vypD+H5VKVppWrTJsRHPt+VMIqbFMIqkxEZ/wA8Uw1KRTStUmSQEU0ipitNIq0xWITSGpCtN200ySM001IRSEVVxERptSEU3FVcQymGpSKYRTQiOkNPIppFVckZSU8ikxTERmkNPIppFMQ00hp+KaRVXENppp5FJimAyilIpKYhKSlpKBDTSGnUhpiG0lOpKYhtFLSUwEpKdSUxCUlLRQIaaQ040lMBtFLSUxCUUuKDQA2ilopiEpKdSYoASijFFACUUtFMQlJS0UAJSUtFMBKKKKBCUlKaKAEopaSmAlLRRQAUlLRQAlFLSUAFFFFABSUtFACUUtFAhKKKKYCUUtJQAUUUUAFFLSUCCiiigAooooAKKKSgApaSloASiilpiEopaKACikooAKKKKACiiloASiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKYBSUtFABRRSUAFLRRQIKKKKBiUtJRQIWkpaKACikooAWikpaACiiigAooopgFJS0lAC0UUlABRRRQAUUtJQAUUUUAFLSUtACUUtJQAUUUUAFFFFABRS0lAC0UlFAHr5WjFPNNxXyR9EJijFOAoxRcBMUYp2BS4ouA3FGKWigBpFNIqTFIRQBERTStSkUw1SERFaYVqU001SYiEimkVKRTSKpMlkJWmlalIppFWmSREU0ipCKaRVXERFaYVqYimEVSYmiEimkVKRTTVpkkRFNIqQimkVSERkU0ipCKaRVIlkeKaakxTCKpCIyKQinkU00yRmKaRUhFNqhDDTSKeRTTTQhtJTjSUwGmmmnmmEVQhCKbinUhpkjcUhpxpDTENpKdSUANxSYp1FMQ3FJinUhpiGUYpTRTENpKdSYpgJSUppKYhMUlOpKAEopaKYhuKSnUUANopaSmISiiigBKKWkpiEopaKAEpKWimAlJTqQ0AJRiiigQlFLSUwCkpaKACkpaSgAooooASilpKACiiigAooopiCkpaSgAooooAKSlooEJS0UUAJRS0lABRRRQAUUUUxBRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRTAKKSlpCCkpaSmMKKKKACiiikAUUUUAFFFFMAooooEFFLRQAlFLRQAlFLRQAlFLSUAGKKKKACiiimAUlLRQAUlLRQAlLRijFABRRRQAUUUUAFFFFACUUtFABRRRQAUlLRQAlLRRQAUUUUAFFLRQAlGKWigBKKKKACiiigBKKWigD2I8mjFNJ/lS5r5E+iFooFOFIY2lxS8UvFAhuKMU6koASmGnmmmmAw03FPNNqkIYRTDUhppqhEZFNIp5ppqkIYRTCKlIphFUmIiIppqUimEVSJZEaYRUpFMNWiSMimkU8001aEyMimmpDTDTRIw00040lUhEZppFSmmGqQiMimkVIaaRVIkYRTCKkNNNUhEZFIaeRTSKaEMxTaeRSYqhDcU008000xDabin0hpiGGkpxFIaYhtJTqSmIbSU6kxTENopaQ0wGmkp1JTENNFLSUxCUlOpKYhKSnUhoASkp1JTEJSUtFADaSnUlMQlFFFACUlLRTASilxRQISkpaKYCUUUUAJRS0lAhKKWkpgFFFFACUUtFACUUtJTEJRRRQAUlLRQAlFLSUAFFFFABSUtJQIKKWigBKKWkpgFFFFAhKKWigBKKKKACiiigAooooAKKKKYBRRRQAUUUUCCiiigAooooAKKKKACiiigBKKWigBKWiigBKKWigAooooAKKKKACiiigBKWiimAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABSUtFABSUtFACUUUtACUtFFACUtFFABRRSUwFooooEJS0UUAFFFFABRRRQAUlLRQAlFLRQB64Tz+FKDURalDV8lY+iuTg0oqINShqmw7kuaM0wNS5osA7NGaaTSZosA7NITTd1JmnYVxTTCaUmm1QATTTSk00mmhDTTTSk0mapCENNNKTTSapEjTTDTjTDVIQ00w080w1aEMNNNPNMNUiRpppFKaQ1SJYw0004001QhKaadTTVCG00040000IYaQ04001SJGmmU8001QhtJSmkpiENNNONJVCG0hp1NpiG000802mIbSU6kNMQ2kpTSUxCUlKaSmIKbTqSmA00UtJQITFJTjSUxCUUUUwEpKWimISkpTSUAJSU6kpgJRRRQISkpaKYCUUtJQIKSlpKYBSUtFACUlLRQISiiimAlFLRQAlFLSUCCkpaKYCUUUUAFJS0lABRRRQISilpKACiiigAooopgJS0UUCEopaKAEooooAKSlxRQAUlLSUAFFFFMAooooAKWkooAKKKKBBS0UlABRRRQAUUUUAFFFFABRRRQAUUUUAFFJS0AFFFFMAooooAKKKKACiiigAopaSgAoopaAEoopaBCUUtJQMKKKWgBKKWigQlFLRTASiiloASilooASilooATFFLRQAlFLRQAlGKWigBKKWigBKKWigBKWiigAooxRQAUlLRQAlFLRQAlFLRQI9R3U4NVffS76+X5T6C5ZDU4PVYNTg9TyjuWQ1LuqAPS7qXKO5NupN1RbqN3vRyiuS7qTdUW6jdRyhckLUm6o91G6nYLjyaaTTS1NLU7CuOJpu6mk0maqwrilqaTRmmk0xATTSaCaQ1QhpNIaU001SEJTTSk03NUIQ0w04mmmqQhpppp1IaokYaQ04001QhppppxphpoQ0000402qQhppKU0lUSNNNpxpppiENJSmkpiENJQaSmIKaadSGqENpDS0hpiG0lLRTENNJTjSUxDaKWkoAQ0lOpDTENpKU0UxCUlLSUwEopaSmISkNOpDQAlJS0UwEpKWkoEFJS0UwEooooEJRS0lMBKKWkoASiiigQUlLRTASiiigApKWkoEFFFFMBKKWkoAKKKMUCEooooAKKKKYCUUtFACUUYooAKKKKYgooooAKSlooASiiigAooooEFFFFAxKKKKAClpKKBC0UUUAFFFJQAtJRS0wEpaKKAEopaSgAooooAKKWigBKKWigQlFLRQAUUUUAFFFFMAooooAKKWigBKKMUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUtACUUtFACUUtJQIKKKKBhRRRQAUUUUxBRRRQAUUuKKAEopaSgAopcUUAJRS0UAJRS0YoAbRS4ooA9E3UoeoN3NLur5vlPcuWA1PDVWDU8NSaHcsBqXdUAal3VNh3J91JuqHdS7qLDuS7qN9RbqM0WFcl3UZqLdRuosFyXNJmot9G6nYLjy1NzTSaTNOwrkmaaTTd1IWp2C4pNITTSabup2FceaaTSZpCaaQgJphoJppNUIU000ZpM1SEJSGgmm5pkhSE0E00mqAQmmmlJppqkSNNIaU02qEwpppaaTTEIabS5pKYgpppaSmhDaSlpKoQlJSk0hpiEpKU0lMQlJS0lMQlJRRTEJSUppKYBSUtJQISkpaSmIDSUtJTASkpaSmIKSlooAaaKWkpiCkpaSgBKKWkpiCkpaSgApKWimAlJTqSgQlFFFACUUtFMBKKKKACkpaSgQUlLQaYCUUUUCEopaKYCGkpaKAEopaKAEopaKYhKKKKAEpaKKAEopaSgAooopiCilpKQBRRRTAKSlooASjFFFIAooopgFFFFACUUtFABRRRQAUUUUCCilopgJRRRQAUYopaAEopaKAEopaKBCUUtFACUuKKKACjFFLTASilpKACkpaKAEoxS0UAFFFLigBKKWigBKKWkoATFLiiigAooooAMUUtGKAEoxS0UAJijFLRQAlFLSUAFFFLQAmKKWkpgFGKXFGKACkpaKBCUtFFACUtFFABijFLSUAJiilooA7fdShqh3Uu6vn7HtXJw1ODVXDU4NSsO5Y3Uoaq+6nBqmw7k++jdUO6l3UWC5Nuo3VDupd1KwXJS1Gai3UbqdguS7qN1RbqN1FguSFqTdTN1GaLBcdmkLU3NJmnYVx2aTNNzSbqdhDyaaTTSaaWp2C48tTSaaTSZp2FccTTSaQmkzVIQuabQTTSaYCk00mkJppNNEi5pM0maQmqEBptBNNJqhCk00mgmm0xC0hozSE0xATTTQaSmIDSUUhpiENJS0hpiCkopKYgpKKQ0wCkopKYgpKWkpiCkoopgIaSlpKBBSGlpKYCUUUUxCUUtNoAKSlopiEpKWkNABSUGimIKKKSgAooopgFJS0lAgpKWkoAKSlopgJRS0lABRRRTEJRRRQAUlLRQISiiimAlFLSUAFFFFMQUUUUAJRS0UAJRS0UAJRRRTEFFFFABRRRQAlFFFABRRRQAlFLSUCCilpKACiiigAoopaYCUUtFACUUtFABRRRQIKKKWgBKKWimAlFLRQAlLRRQAUUUYoAKKKKBBRRRQAUUtFACUUUUwCiilxQMSilooEJRS0UAJRS0UAJRRS0AJRS0UAJRS0UAJRS0UAFFFFABRRRQAUUUUAJS0UUAFFFFACUtFFABRRRTATFLRRQAUUUUAFFFFAjq91LuqLdS7q8Kx7FyYNShqhDU4NSsO5OGpwaoQaUGpsO5NmlzUO6lzRYLku6jNRbqXdSsFyTNLuqLdRmiwXJt1JuqPNJuosO5LmkzTN1Jup2C5JupN1R7qN1FhXHlqTdTM0Zp2FccTSZppNNJ96dguPzSZpmaM07CuPJppNJmmk07BcUmjNNzSbqdhDiaaTSZpCadhXAmkzSZpM0xAaSgmmmqEBpKWkJpiEoozSZpiA00mlJpppoQUlFJmmIWkpM0maYC0lBpDTEJSUtJQIKSjNJTAWkoopiEoopKYgoNFJmmAUlLSUAJRQaKYgpKWkoASiiimISiikoEFJS0lMAooooAKSlpKYgpKWkoAKSlpKACiiimIKKKSmAUUUUAGKMUUUCEopaSmAUlFFABRRiigAooopiCkpaSgAooooAM0lLRQIKSiimAUUUUAFFFFACUtFJQAtJS5pKYgooooAKSloxQAUUUtACUUUtAhKKKKACiiimAUtFFABRRRQAUUUUCCiiloAKKKKACiiimAUUUUAFFFFABRRRQAUUtJQAUUUtACUUUtABSUtFACUUtFMApKWigQlFLRQAlFLRQAlLRRQAUUUUAFFFLQAmKMUtFACYopcUUAJRRRQAUUUYoAKKWjFMBKKKKQBRRRQAUUUUAdFmlzTM0ZrxbHrXJQaUNUQNLmlYdyYNTt1Qg0u6lYLku6l3VDupQ1Fh3JgaN1Rg0ZpWC5Luo3VFmlzRYLkm6jdUeaM0WC5JmjNR5ozRYLj80ZpmaM0WAfmjdTCaTNOwXHZpC1NLUmaLCuO3UmabRmnYQ/dTSaTNITTsAuaSkJpM0xDs0hNNzRmmIXNITxTc0hNMBc0maTNGaYgJpM0hNJmmIUmkzSGkpiFzSUUlMQUlBpM0xBRSUUwEpCaU02gQUtJRTAKSiimAlFFJQIU9KSikpiCkpaSmAUlFFAgpKKKYBSUtJQIKSlopgJSUppKBCUUUUwCiiigBKKKKYgpKWkoAKSlopgJRS0UCEooooAKSlpKYgooooASiiimAUUUUAFJS0lMQUUUUAFJS0UAJRS0lMQUUUUAFFFFABRRRQAlFLSUxBSUtFACUUtFACUUtFACUtFJQIWiiimAUUUUAJRS0UAFFFFABRRRQIKWiimAUUUUAFFFLQAlFLiigBKWiimIKKKKACiiigAopaKAEopaSgAopaKAEooooAKKWjFACUUveigApKWimAUUYooAKKKKBCUtFFABRS0lABRRRQAUUUUAFFFFABRiiigAooooAKKKKACilpKACkpaKAEopaKANvNKDUeaUGvHseqSZpc1GDSg0rDJc0ZqPNLmlYLj80uaZmlzSsO5IDS7qjzRmiwXJN1GaZmjNFguS5ozUeaM0WAfmlzUeaM0rBcfmlzUeaM07BcfmkzTc0ZosAuaM03NJmmIdmjNNzRmgB2aaTSZpCaYhc0ZptGaYC0maTNJmgQ6kpM0hNMBTSE0hNJVCDNFJSUxC0maDSZoAXNJmkzRmmIDSUE03NMQtGaSigQE0lFJTAKKSimAUUUUCEooopiEooopgJRRRQISiiimAlFFJQIWkoopgFJS0lABSUtFMQlJSmkoAKKKKBCUUUUwEopaSgAooopiCkpaKAEooopgFJS0UCEopaSmAUlLRQAlFFFMBKKKKBBRRRQAUUUUxBSUtFACUUUtACUUUUxBRRS0AJRRRQAUUUUAFJS0UxCUUtFACUUtFACUtFLQISijFFACUUtLigBtFLRTAKKKWgBMUUtFMQlGKWigAopaKACiiloEJRRS0wEopaKAEopaMUAJRS0UAJRilooASilooASjFLRQAmKWiigAooooAKKKKACkpaKYCUtFFABRRiigAopaKBDaWjFFAwopaSgQUUUUAFFLijFACUUuKKAEpaKKACkpaKAEopaSgAooooA1M0oNMzRmvIseoSZpQajDUoNKw7koNLmowaXNFguPzS5qPNGaVh3JN1GaZmjNFgJN1Lmo80ZosFyTNLmos0uaLAPzRmm5pM0rBcfmlzTM0ZosFx+aTNMzRmnYB+aM0zNGaLAOzRmm5ozRYLjqTNJmkzTsIdmkzSZpCadhC5ozTc0maAHZpM0maTNMQuaTNJmkpgOzSZpM0maYhc0maSigQtFNzRmmAGigmkNMQZpM0UlAC0lLSUxBSUUUAGaKKSmIWkopKAFpKKSmIKKSloAKSiimAUlFFMQUUlFABRRmigQUUUlMBDRSmkoEFFFJTAKKKKACiikpiCiiigAooopgJRRRQIKKKKYBSUUUAFFFFAhKKWkpgFJS0UAJRS0mKYBRS0UCEopaKAEooopiDFFFFABRRRQIKKKKYCUUUtACUUtFACUtFFMQUUUUAFFFLQAlFLRTEJiilpKACilpKAEopaKACloooASlpaMUxCYpcUUUAFFFLQAlFLSUAFFLRTAKSlooEGKKKKACiiigBKKWigBKWiigAooooAKKKKACiiigAopaKAEopaKYCUUtFACUUtFACUtFFAhKMUtFACUUtFABRRRQAlLRRQAUUtFACYpKdRQA2ilooASilooAvZozTKK8mx6dx+aUGmUZosO5KDS5qPNLmlYLkmaM0zNGaLBcfmjdTM0ZosO5JmlzUYNLmlYLj80ZpmaM0WAfmjNMzRmiwXJM0ZqPNLmiwXH5pN1NzSZosBJmjNMzRmiwDs0ZpuaM07BcdmjNNzSZosIdmkzTc0madgHZozTc0maBDs0ZpuaKdgFzRmkzSZosIXNFJmkzTAXNJSUUxC0maKSgBc0UlJTAWikooEFFFFABSUUlMQtJRRTAKSiigQUUUlMAopKKACiikoELSUUUwCiikoELRSUUwCkpaSgQUUUUwEoooNABRSUUxC0UUUAJRRRTEJS0lFABRRRTAKKKKBCUUUUAFFFFMApKKKACiiimIKKKKACiiimIKKKKACiiigAooopiEopaKAEopaKAEopaSmAUtJS0CEopaKAEopaKYCUtFFAgoxRRQAUUtFAhKKWimAlGKWigBKWiloASloopiCiiloASiiloASilopgJRS0YoASjFFLQAlFLiigAooooAKKKKBCUtFFABRRRQAUUUtACYopaKAEpaKKAEopaKAEopcUUwCjFGKKBBRRRQAYopaKAEopaKAEopcUUWASilooAKKKKADFFFFACUUtFACUUtFAE+aM03NGa8ux6Y8UuaYDS5pWAfmjNNzS5pWAdmjNNzRmiwx+aM0zNLmiwDs0uabmjNFguOzRmm5ozQFx2aM03NGaQDs0uaZmlzQFx2aM03NGaLBcdmjNNzRmiwXHUU3NLmgLi5ozTc0Zp2C4uaSjNJmiwhc0UlJmmAtLmm5ozQApopM0maYhaM0maTNAC5opM0ZpiFpKTNGaAFopKKACijNJTELmjNJRmgAopM0ZpgFGaSjNAgopKKYC0UmaM0CCijNJmmAtJRSUALRSUUxC0lFFABSUUUCCikpaYBSUtJQIKKKSmAUUUUAFFFFMQUUUlABRRRTAKKKKACiiigQUlLSUwCiiigAoopKBBRRS0wEopaKYhKKWigBKKWimISiiigAooooAKKKWmAlFFFAgooooAKKWimISilooASjFLRTEFFFFABRS0UAJRS0lAgopaKADFFLSUwCjFFLQAlFLRTAKKKKBBRRRQAUUtFMApKWigBKKWigAopaKAExRilooATFGKWigQmKKdSUAJRS0UAJRzS0UBcSloooAKKKKACiilpgJigUtFACUUtFAhKKWigBKWiloASkp1JQAUUUYoAKMUoFGKYCYopaKAEopcUYpANxRinYooAbRS4opgOzS5ptFeUekOzS5poNFAXH5ozTaM0h3H5ozTc0ZoAdmlzTc0UWAdmlzTM0ZoAfmjNNzRmiwx2aM03NLSAdmim5ozRYB2aM0maTNADs0ZpuaM0WAdmgGm5ozTsIdmjNNzRmiwDs0maTNJRYLjs0maSigBc0UmaTNMB2aM03NGaBXFopKKACiikNMQtGaSigBc0U3NFADs0maTNGaYC5pKSigQtFJRTAKM0maKBBRRRTAKKKSgBaKSigQtJRSUwFopKKBBRRRTAKSiigAoozRQIKKKSmAUUUUAFFFFMApKKKBBRRRQAtJRRTEFFFFABRRmimAUUUUAJRS0lAgooopgFFFFMQUUUUAFFFFMQUYopaAEooopgJS0UUCCiiimAlLRRQIKKWigBKKKKYgoxRS0AFFFFAgoopaYCUUtFACUYpcUtACUUuKMUxCUUuKKAEopaKAEpaKWmAmKKXFGKBCUUuKKADFFFFABRRS4pgJRTsUUANxS4oooEJiilpaAEooxS0AJRS0UAJiiiigAoopaAEoopcUAJRilopgJRS4oxQAUYpaKBCYoxS0YoATFGKXFFACUuKXFFOwCYoxTqSgVxMUYpaXFADaMU7FFAXExRiloosAlGKXFGKAuNxRinUmKAuJRS0UWC4yjNNzRmvLPTHZpabS5pALmlptFADs0tNoosMdmjNNpaQDs0U3NFADqKTNFAXHZozTaM0BcdRTc0ZoC47NLTKXNAC0ZpM0UALmikozQAtLTc0ZpgLRSUUALSZozSUALRSZooELRSUUALmjNNpc0wFpKTNFAC5optGaBC0UmaM0wCikzRmgBaKSjNAhaKSimAtJRSUALRSUUCFopM0tMApKKKACiikoELRSUUwFzSUUUAFFFGaYgpKKKACiikoAWikopiFpKKWgBKKKKYgooooAWkopaYBSUUUCCiiigApKWkpgFFFFABRRRTEFFFFAgooooAKWkopgLRRRQISloopgFJS0lMApaM0UCDFFFFABRiiimIKKKWgBKKWimIKMUUtACUUtFMQUUUtACUuKKKACiilpiEopaKAEopaKAExS0UUwCilooEJijFLSUAFFFLQAmKWilpgJRilooASilooAKKKKBCUUtFACUUtFACYopaKYCUYpaKAEpaWigBMUUtFACYpcUUtAhKKXFFOwXEopaWgBMUYpaMUWFcSilxRiiwCYop2KMUwEoxS4ooATFGKWloAbijFOpKAExRS0UAJRiiigBMUU6igCtmjNJRmvKPTFzS5ptGaQDs0tNpaAHZopuaM0AOpc03NGaBjqM03NGaAHZpc0zNLmgB2aTNJmjNAC5pc03NFADs0ZpuaM0AOzS0zNLRYB1Jmm5pc0ALmjNJmigBc0ZpKM0ALmjNNzRQA7NGabRmgQ7NGabmjNAC5ozSUUwFzRSZpM0ALmikzRQIXNFJSUwFozSZooAWikooAWikpKBDqKSjNMBaSikoAWikooEOpKKSmAtFJRQAtFJRQIKKKKYBRRSUALRSUUAGaKKKYgooooAKM0UUxBRRRQAUUUUwCiiigQUUlFABS0UUwCiiigQlFLRTASiiloEJRRS0wEopaKAEopaSgQtFFFMAooopgFFFFAgoooxQAUUUUxBRRS0AFFFFMQUtFGaACiiimIKKWigAooopgFLRRQIKKKWmISijFLQAlLRRQAUUUtMAoopaAG0UtFACUUtGKYgopaKACilooASilxRQISilooASjFLRTASiloxRYLiUYpcUuKLAJRilxRRYQlGKdijFAXG4oxTsUlACUtLijFMBKMU7FGKLCEApaMUuKAExRilxRimAlFLijFFgEoxTsUYosIbijFOxRRYLiUUuKMUWC42jFOoxQA3FFOxRiiwXG0UuKKBiUUYooEUs0UUleUeoOBozSUUAOzRmkopAOzRTaWgYuaXNNooAdRTc0uaAFpabmjNADqKbmloAWikooAWikzSZoAdRmm5ooAdRSZozQAtLmm0UAOzRTc0UALRSUUALmkzRSZpiHUZptGaAHZopuaKAFopM0UCFozSUUALSUUlMBaKSjNAC0ZpM0UALRSUUALRSUUCFpKKKYC0U2loAWkoooAWjNJRTEFFFJQAuaKSigBaKSimIWikooAWkoopiFopKKAFpKKKAClpKKYhaKSigBaM0lFMAooooEFFFFMAzS0lFAC0lFLTEJRRRQAtFJS0CEpaKKYBRRRQAUUUUxBRRRQAUUtFMQUUUUAFFFFABRRRTEFFLRigAooopiCloooAKKWjFMQlLRiigAoopaYgoopaAEpcUUUxBikpaKADFFLRQAUUUtMApMUuKKAEoxS0UxBRRS0AJS0UUCDFLRRimAlLiiloAbilxS0YosAmKMUuKXFOwhuKMU7FFFgExRilxRiiwCUYp2KMUWAbijFOxRiiwriYpcUuKMU7BcTFGKdijFFguNxS4p2KMU7CuMxRinYoxRYLiYoxTsUYosFxMUYpaKLCuJijFOxRiiwXG4oxTsUlFguJiiloxQAlJTsUUWGNxRinYoxRYLjMUU6ikFzMpc0lFeSeqLmlzTaKAHZozSUUAOoptGaAHZozTaWgBaAaKKAFopKKAFopKKAFzS5ptLQAuaTNJRmgBc0tNooAdRmkooAXNFJSUALmlzTaWgQuaWm0UDFpKKKBC0maKSmAtGaSjNAC5ozSUUALmkzSUUCFzRmkooAWikzRmgBaKTNFMBaKKKACikooAXNFJmjNMQtGaSigBc0UUZoAM0tJSZpgLRSUUCFzRSUUALSUUUAKKKTvS0xBRSUUALRSUtMAoopKBC0UlFAC0UUlMBaKSloEFFFFMAooooEFLRRQAUUUUxBSUUUALRSUtMAooooEFFFFMAooooAWiiimIKKKKACiiimIKWkpaACiiigAoopaYhKWiigBaKKKYgpaSloAKKMUtMQlGKWigBKWiimIWiiigAoopaYBRS0UCExS0UUwEopcUtACYopcUUCEop2KMUwEoxS4paYhMUUtGKAEpaMUYoAKWjFFMQlLRS0WATFLilxRiiwriYpcUoFLTsFxuKAKdRiiwriYoxS4pcU7ANxS0uKMUWC4mKMU4CjFOwrjaKdilxRYLjMUuKdijFFguNxRinYoxRYVxtLilpcU7BcbijFOpMUWAbijFOxRiiwXG0UtFKwxKTFOoosA2kp1FKwDaKWigLmTRSUV5B6wtFJS0ALmikooAWiiigBaM0lFADqKSigBc0UlLQAUtNpaAFopKKAFopKKAFopKKAFopKKAFzRSZozQAtFJRQAuaKSigBaKTNFAC5ozSZooEGaKSimAtFJRQAUtJRQAUUUlAC0UlFAC5ozSUUxC5paSigAooooAKKSigB1FJS0AFFJRTELSUUUAFLSUUALRSUUxC0lFFAC0UlLQAUUUUwCiiigQUUUUAFFFFMAooooELRSUtMAooooEFLSUtABRRRTEFFFFABRRSUwCilxRQIKKKKYBRRRQAUtJS0xBRRRQAUUUtAgooopgFFFFMAopaKBBRRS0AJRS0UxBRRiloAKKKWmIKKKKBC0YoopgJSilooAMUUUUxBRRS0AGKKKWmAUUUtMQlLRS0CExRilpaYCYopcUYpiEpcUuKMUAJS0UuKBCYoxS4pcUwExSYp2KMUWC4mKMU7FLinYVxuKXFKBRinYVxMUuKXFGKLAJilxS4pcUWC43FGKdijFOwriYoxS4pcU7CuNxS4p2KMUWC43FLilxS4p2C4zFLinYoxRYVxuKMU7FGKLBcbilxTsUYosFxmKTFSYpMUWC4zFFPxSYosFxlFOxSYpWGJRS4oosA0ikxT6TFIY3vRS4opAY1FJmivIPXFooooAM0ZoooAWikpaQBS0lFAC0ZpKKAHZozTaWgBc0UlFAC5ozTaXNMBaKSlpAFFJRQAtFJRTELRSUtABRSUUALRSUUALRSUUALSUUUALRTaXNAC0UlFAC0maKKACikopiFopKKAFozSUUALRSUtABRRSUwFopM0UCFpabRQAtFFJmgB1FJmigQuaSiimAtFJS0AFGaSimAtFJS0CCiikoAWlpKKAFopKKYC0UUUCCiiimAUtJRmgBaKKKBBS0lFMQUtJS0AFFJRTAWiiigQUUUUwClpKWgAooooEFFFFMApaSigBaKKKYgooooAWiiimIKKWigQUUUUwCiiloAKWkpaYgoopaAEpaKKYhaKKKAFopKWmISloooAKKKWmIBRRS0wCiiloEFFFLTAKWkFLTELRRRQIKKKWmAlLRS0CCiilpgJS0UtMQYoxSiloATFGKWimIMUuKKWnYQmKXFLijFAhMUYp2KMU7AJijFOxS4p2FcbilxS4pcU7CuNxRinYoxRYLjcUYp+KMUWC43FJin4oxTsFxuKMUuKMUrBcbijFOxRiiwXGYop2KMUDG4pCKcaSkA3FFOpMUrDG4pDT6QikAyilxRQMwqWkorxj1xaKSigBaKKKAFopKKAFopKWgApabRQAtLSUUALRSUUAFLSUUALRSUUALRSUUAOopKKAFpKKKACikooAWjNJRTELRSUUALRSUUALRSUUALRSUUALmikooAWikooAWikozQAUUlLTEFLSUUAFFFJQAtFJRQAtLSUUwFopKKBC0UlFAC0UlLQAtFJRTELRSUUALRSUUALRSUUALRRRTAWiiigQZooooAKWkopiFooooAKKKKYC0UlFAhaKKKYBRRRQIKKKMUAFLRRTAKKKKBC0UlLTAKKKKAClpKWmISloooAKKKKAFooopiCiiigQtFFFMAooooAWlpKWmIKWkpaYgpaSigBaKSlpgFFFLQIKKKKYBS0UUCFoopaYBRRS0xBRRRQIUUtJS0wCilopiAUtFFAgxSiilpiEpcUUUwFxRRRTEAp1IKdTEJijFOxRiiwhAKXFLilp2C4mKXFFLTEJilxS4pcUxXExS4opaYriYpcUuKAKYriYpcUuKXFOwXG4oxTsUYosK43FGKdRRYLjMUYp2KMUWC43FGKdijFKw7jMUhp+KTFFguNxSYp2KKVh3GYoxTsUmKVh3G0mKfTcUrDuNxRS4opAc9RRRXjHsi0UlFAC0UUUgCiiigBaM0lFAC0ZpKKYC0tNpc0gCijNJQAuaKSloAKKKKYC0ZpKKQBS5pKKYhaKSigAooooAKM0UlAC0UUlAC0UZooAKKKKADNFJRQAtFJRTAXNFJRQIXNFJRQAtGaSigAzS0lFAC0UlFAC0UlFMQtFFFABS0lFAC0UlFAC0UlLTELRSUUALRSUUALRSUtMAooooAWikpaBBRRRTAKKKKAFopKWgQUUUUwClpKWgQUUUUAFLmkopgLRRmigQUUUUwFopBRQAtLSUUCClpKKYC0UlFAC0tJRTELRSUUALRSUtMQtFFFABRRRQAUtJRTELRSUtABS5pKKYhaWkpaAFopKXNMQUUUUALRRRTAWikooEOopBTqYgpaSimIdRSUtMApaKKYhaKKKBC0UUtMQUUUtMApaKUUxBRilopiCilooABTqQUtMkWiilqhBS0lOoATFLRS0yQpaKXFMQlLilxRVCDFLRilxQAmKXFLilp2FcSjFLRTFcTFJinYpcUWAbikxT8UmKLBcbijFOxRigLjKCKdikxSsO4zFGKdijFKw7jMUUuKSkMaRSYp1IaTGNopcUUhnNUtNpa8Q9kWkoooAWikooAWikooAWjNJRQAtLSUUAFLSUUALRSUUALRSUtABRmiigAzRSUtABS0lFAC0lFFAC5pKKKACiiigAopKWmAUlLSUCClpKKAClpKKAFopKKACiiigBaKSigBaKSigBaKSimIWikooAWiiigAooooAWikooAWiiimAUtJRQIWikooAKWkooAdSUUUwClpKKBC0UlLQAZpaSimAtFJmigBaWkozQIWikopgLRRRQIWikooAWiikpgLRSUUALS02loELRSUUwFpaSigBaKSloEFLSUUwFopKKBC0UlLTAWikopiFpaSigBaSiigBaKSloEFFFFMBaKSigB1FJS0xC0UlFMBaWkooEOopKWmIWkoozTAdRSUtAhaWkopiFopKWmAtLSUUCHUUlLTELRRS1QgpaSloEOpabS0xC0tJmimAtFFFMQopaSlpoQtLSUtMQuKWkpaYhaWkpaYgpwpopwpoTFpcUlLTJFoxRS0xMMUuKKWqEGKMUUUxBiloooATFLilpKAEoIpaKQxmKMU6koC42kp1JikMbikxTqSkNDDRTiKbUsoTFFLRSA5alpKK8M9sWikooAWikooAWiiigAooooAWkoooAKWkpaACikpaACiiigAooooAKKKKAFpKKSgBaKSimIWiiigAopKKAFooooAKKKKAEooooAKWkooAWikooAKKKKACiiigQtFFFMAooooAKKKKAFoopKAFopKWgAooooAKKKKYhaKSigBc0UlLQAUUUUwCiiigBaKSigQtFJS0ALRSUUwClpKWgQUUUUALRSUtMAooooEFAoooAWijNJTAWiiigAooooAKWkooELS0lFMBaKSigBaWkzRQIWjNJRTAXNFJS0CClpKKYC0UlLQIKKKKYC0UlLQAUtNpaAFopKKYh1FJRQAtLSUUxC0tJRQA6ikzRTEOopM0tMQtApKWmFhaWm5pc0xC0tJRmgQtFJS0wFpaSimIfmim5paYhaWkpaYhaWm0tMQtKKbTgaAFpaQGjNMkdS02lFMQ4UtJS1QhaUU0GnUxC0tNpc0xDqXNNzS00SOFLTaUVQhwpRSUtMQtLTaWmIdRSUuaYhaKKSgBaKKKBCUUtJQMSiigmgBKQ0ppKTGIabTqbUlIQ0lKaQ1IxMUUUUDOWopKWvDPbCikpaQBRRRQAUUUUAFLSUUALRSUUALRSUUALRSUUwFzRSUtABRRSUCFooooAKKKKACiiigAooooAKKKKACikpaACikooAWiiigAopKWgAooopgFFFFAgopKWgApaSigBaSiigApaSigBaKSigBaKKKYgpaSigYtFJRQIWiiigAoopKAFooooAWikpc0wCikzS0CCiiigBc0UlFMBaM0lFAC0UUUCFopKKAFopKWmAtFJRQIWikooAWlpKKAFopKM0wFopM0tABS0lFAhaKSimAtFJmloAKWkpaBBRRRTAWikooELS02loAWikopgLRSUUCFpc02lpgLRSUtAC0UlGaYh1FJRQAtFJS0xC0UlLQAopabS5piFpabRQA6lpuaM0xWHZpc02jNMQ7NLTc0ZpgPoBpuaUUXEOzS03NGaoQ8GlzTc0UxDs0tNzS0xDqBSZozQIeDRmm5pQaoQ4U6mUtMQ/NGaaDSg07iHUuabRmmIeDTqjzSg0xWJKWo807NO5Nh9LmmZpc1VxWH5ozTM0Zp3FYkzS5qPNLmncVh+aXNMzS5p3FYfmjNMzRmi4WJM0UzNGaLisOpM0maTNFx2HZpKTNJmlcLDqTNJmkzQOwuaSkozUjA0lBNNNIoWim5opAcvRRRXiHtBRRRQMKKKKBBS0lFAC0UlLQAUUUUAFFFFABRRSUALRSUUALRRRQAUUUUAFFFFABS0lFABRRRQAUUUUAFFFFABRRRQAtFJRQAUUUUALSUUUxBRRRQAUUUUAFLSUUALRRRQAUUUUCCiiigAooopgLRSUtABRRSUALRRRQAUUUUAFFFFABS0lFMBaKKSgQtLTaWgBaKTNFAC0ZpKKAFzRRSUwHUUlFAhaKSloAKKKKAClpKKYC0tJRQAUUUUCFopKKAFzRmkpaYC0UlFAC0UlFAhaM0UUALmikopgLS02lzQIWkoopgLRSUUALS0lFAhaKSlpgGaWkzRQAtFJmlpiFpabRQAtLSUUxC0tJRmgBaKSimIdRmkooAdRmkzRTAUGlzTaWgQ6ikzRmmIdmim0uaYh1Lmmg0uaYDs0tMzS5pisPzRmm5ozTuKw/NLTM07NO4rDqUUwGlzTuIdmnZpmaM07isPzS5pmaM07isPzS5pmaXNO4rDs0uaZS5p3FYkBpc1HmlzRcViQGjNMzRmquKxJmjNMBpc0XCw/NLmo80uadxWJA1LmowaXNO4rD80U3NG6ncVh+aM0zNGaLhYfmkzTc0ZouFh2aM03NGaLhYdmjNNzSZouFh2aSkzRSGBNIaKQmkOwlFFFIZzFGaKK8U9gKWkooAWikpaACikpaACiiigAooooAKKKSgBaKKKACiiigApaSigBaKSigBaKSigBaKSigBaKSigBaKSlpiCikpaACiiigAooooAKKSloAKKKKACiiigAooooAKKKKACiiloAKKKKBBRRRQAUUUUwCiiigAooooAWikpaACiiigAooooAKKKKACiiimAUtJRQAtFFJQIWikpaACiiigApaSigBaKKKYBS0lFAhaKSigBaKKKAClpKKYC0UlLQIKKKKAFopKKAFopKKYC0UUUAFFFFAhaKSigB1FJRTAWikooAWikooELS0lFMBaKSloEFLSUUwFpaSigBaM0lFMQ6ikzRmgBaWkopiFopM0UALS5ptLmgBaWm0tMQ7NGabRTEPopuaM07hYfRmm0uaBWFzS5ptFO4rD80uaYDS5p3AdmlBpmaXNO4rD80uaZmjNO4rEmaM0zNKDRcVh+aXNMzRmncVh+aXNMzS5p3Cw/NGaZmlzTuKw/NGaZmlzRcViTNGajzSg07isSZpQajzRmncLEmaM0zNLup3FYfmlzUeaXdTuKw/dS5qPdRuouFiTNGajzS5ouKxJmjNMzRmncLDs0ZpmaM0rhYfmjNMzS5p3Cw7NGabmkzRcLDs0maTNJmlcdhc0U3NFFwsc3S0UV4x64UUUUAFFFFABRRRQAUUUUAFLSUUALRSUUAFLSUtABRRmigAooooEFFFFABRRRTAKKKKACiiigApaSigApaSigBaKKKACiiigAooooAKKKKACiiigAooooAKKKKAClpKKAFopKKBC0UlFAC0UUUAFFFFMApKWkoAKWiigAooooAWikooAWikooAWikooAWikpaACiiimAUUUUALRSUZoELRRmigAozRmigBaKSigBaKSlpgFFFFAgpc0lFAC5opKWgAozSUtMBaKTNFAC0UUUCCiiigApaSimAUtJRQAtGaKKBBRRRQAtFJRmmAtLSUUALRSUtMQUUUUALRSUUCFopKWmAuaUU2loAWjNJRQIWikozTAdRSUUALS0lFMQtFJS5oAKWkozTEOozSUUwHUtNzRmgQ6ikzRmmFh1GabmlzQKw7NGabS07isOzRmm5ozTuFh+aM03NGaLisPzS5pmaXNO4WHZpc0zNGaLisSZozTM0uadxWH5ozTM0uadwsOzS5pmaXNO4rD80ZpmaXNFxWH5ozTM0Zp3CxJmjNMzRmi4rD91GaZmjNO4WJM0ZpmaM0XCw/NLmo80uaLisPzRmmZpc07hYdmjNNzSZouFh+aTNNzRmi4WFzRTc0UrhY5+lpKK8k9UWikooAWiiigAoopKAFooooAKKKKACiiigAooooAKWkooAWikoFAC0UUUCCiikoAWiikpgLRRRQAUUlLQAUUlLQAtFJRQAtFJS0AFFJRQAtFFJQAtFJRQAtFJRQAtJRRQAUtJRQAtFJRQAtFJS0AFFFFAC0UlFAgpaSigBaKKKYBRSUUALRSUUALRmkpaACikpaACiiigAooooAKKKKAClpKKAFopKWmAUZpKKAFopKWgBaKSigQuaKSigBaWkooAWikopgLRSUtAhc0UlFAC0ZpKKAFopKKYDs0lJS0AGaKKKBC0UlFAC0ZpKKAFopKM07gOozSCloELRSUUwFzRmkpaAFpKSloAWikopiFpc0lFAC0UlFAhaWm5opgOopuaXNADqTNJmlpiFBpc02lzQAtGaTNFMB1GabS0CFpaSimIWjNJRQA7NGabS0wHUuabSZoEPopuaM0wHZpc02lzQKwuaXNNzRmmIdmjNNzS5oCw7NGabmlzTAdmlzTM0tFxWHZpc0zNLmncLDs0uaZmjNO4rD80ZpuaM0XFYdmlzTM0uaLhYdmjNNzRmmKw7NLmm5ozRcLDs0ZpM0madwsPzRmmZozRcLD80ZpuaM0XCw7NJmm5ozRcLDs0UzNFAWMWiiivLPSEooooAWiiigApKKKAFooooAKKKKAEpaKKACiiigAooooAXtSdqKKACloooEFFFFACUtFFMAooooAKQ0UUAHalFFFACiiiigAooooAKKKKACiiigBKWiigBKKKKAFooooASloooAKKKKBBRRRQMKKKKBBRRRQMKKKKBC0UUUAFJRRQAUUUUwCl7UUUAJS0UUAFAoooAKKKKACiiigAooooAKO9FFMBaSiigAooooELS0UUAJS96KKACiiigAooopgFLRRSAKXtRRTEFJRRQAUUUUAFLRRTAKWiigBO9LRRQAlFFFABRRRQIKWiimAtFFFAg7UtFFMAooooAKKKKYgpaKKACiiigAooooAKBRRTELS0UUAJ3paKKYgpaKKYBS0UUCFpKKKYhaKKKBh3paKKBBRRRTABSjrRRQIUUUUUwCloooEFFFFMBaKKKBBS0UUwFooooEFAoooBi0UUUwCl7UUUCCgUUUwFo7UUUxBRRRQAUtFFACUtFFACd6KKKAE70UUUAf/Z'
    // 距今：不足 1 小时按分钟（xxm），1 小时以上按小时（xxh），24 小时以上按天（xxd）
    const fmtAge = (min) => {
      if (min == null || Number.isNaN(Number(min))) return '—'
      const m = Math.max(0, Math.round(Number(min)))
      if (m < 60) return m + 'm'
      const hr = Math.floor(m / 60)
      if (hr < 24) return hr + 'h'
      return Math.floor(hr / 24) + 'd'
    }

    const ageTitle = (min) => {
      if (min == null) return ''
      const m = Math.max(0, Math.round(Number(min)))
      if (m < 60) return m + ' 分钟前'
      const hr = Math.floor(m / 60)
      if (hr < 24) return m + ' 分钟前（约 ' + hr + ' 小时）'
      return m + ' 分钟前（约 ' + Math.floor(hr / 24) + ' 天）'
    }

    const STATE_META = {
      running: { color: '#3b82f6', bg: 'rgba(59,130,246,.14)', label: '处理中' },
      ready: { color: '#f59e0b', bg: 'rgba(245,158,11,.14)', label: '待验收' },
      queued: { color: '#9ca3af', bg: 'rgba(156,163,175,.14)', label: '排队' },
      blocked: { color: '#ef4444', bg: 'rgba(239,68,68,.14)', label: '错误' },
      done: { color: '#22c55e', bg: 'rgba(34,197,94,.12)', label: '完成' },
    }

    const CSS = [
      '.sa-page{padding:16px 20px;font-size:12.5px;}',
      '.sa-head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;}',
      '.sa-title{margin:0;font-size:17px;font-weight:600;letter-spacing:.2px;}',
      '.sa-sub{opacity:.55;font-size:12px;margin:6px 0 12px;line-height:1.6;}',
      '.sa-chips{display:flex;gap:8px;flex-wrap:wrap;}',
      '.sa-chip{font-size:11.5px;padding:2px 8px;border-radius:999px;border:1px solid transparent;white-space:nowrap;}',
      '.sa-split{display:flex;gap:14px;align-items:flex-start;}',
      '.sa-col-left{flex:1 1 auto;min-width:0;}',
      '.sa-split.sa-with .sa-col-left{flex:0 0 auto;width:56%;}',
      '.sa-col-right{flex:1 1 0;min-width:320px;max-width:560px;position:sticky;top:8px;border:1px solid rgba(127,127,127,.28);border-radius:10px;overflow:hidden;background:rgba(127,127,127,.04);}',
      '.sa-preview-head{display:flex;align-items:center;gap:8px;padding:8px 11px;border-bottom:1px solid rgba(127,127,127,.2);background:rgba(127,127,127,.07);font-size:12px;}',
      '.sa-preview-body{max-height:calc(100vh - 250px);overflow:auto;padding:12px 14px;font-size:12.5px;line-height:1.7;overflow-wrap:anywhere;word-break:break-word;}',
      '.sa-table{width:100%;border-collapse:separate;border-spacing:0;font-size:12.5px;}',
      '.sa-table th{text-align:left;padding:8px;font-weight:500;opacity:.55;border-bottom:1px solid rgba(127,127,127,.22);white-space:nowrap;}',
      '.sa-table td{padding:8px;border-bottom:1px solid rgba(127,127,127,.10);vertical-align:middle;}',
      '.sa-row{cursor:pointer;}',
      '.sa-row:hover{background:rgba(127,127,127,.07);}',
      '.sa-row.sa-on{background:rgba(59,130,246,.12);box-shadow:inset 2px 0 0 #3b82f6;}',
      '.sa-id{font-variant-numeric:tabular-nums;opacity:.75;white-space:nowrap;}',
      '.sa-muted{opacity:.6;white-space:nowrap;}',
      '.sa-ev-yes{color:#22c55e;white-space:nowrap;}',
      '.sa-ev-no{opacity:.35;white-space:nowrap;}',
      '.sa-btn{font:inherit;font-size:11.5px;padding:3px 9px;border-radius:6px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;cursor:pointer;white-space:nowrap;}',
      '.sa-btn:hover{border-color:rgba(127,127,127,.7);background:rgba(127,127,127,.08);}',
      '.sa-badge{position:absolute;top:50%;transform:translateY(-50%);min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:#f59e0b;color:#fff;font-size:10.5px;line-height:16px;text-align:center;font-weight:500;font-variant-numeric:tabular-nums;box-shadow:0 0 0 1px rgba(0,0,0,.16);pointer-events:none;}',
      '.sa-badge.sa-badge-fallback{top:-5px;right:-6px;transform:none;}',
      '.sa-icon-wrap{position:static;display:inline-flex;align-items:center;justify-content:center;}',
      '.sa-table-wrap{max-height:calc(100vh - 238px);overflow:auto;scrollbar-width:thin;scrollbar-color:rgba(127,127,127,.38) rgba(127,127,127,0);}',
      '.sa-hero{position:relative;padding:14px 16px 8px;margin:-6px -8px 10px;border-radius:10px;overflow:hidden;}',
      '.sa-hero-bg{position:absolute;inset:0;background-size:cover;background-position:center;mix-blend-mode:screen;opacity:.9;pointer-events:none;}',
      '.sa-hero > .sa-head,.sa-hero > .sa-sub{position:relative;}',
      '.sa-table thead th{position:sticky;top:0;z-index:1;background:rgba(127,127,127,.10);backdrop-filter:blur(2px);}',
      '.sa-empty{padding:22px 0;opacity:.55;}',
      '.sa-hint{font-size:11.5px;opacity:.45;}',
      '.sa-toast{font-size:12px;color:#22c55e;margin:0 0 10px;}',
      '.sa-md-h{font-weight:400;margin:12px 0 6px;line-height:1.4;}',
      '.sa-md-h1{font-size:1.34em;}',
      '.sa-md-h2{font-size:1.18em;}',
      '.sa-md-h3{font-size:1.06em;}',
      '.sa-md-p{margin:0 0 8px;white-space:pre-wrap;}',
      '.sa-md-ul,.sa-md-ol{margin:0 0 8px;padding-left:18px;}',
      '.sa-md-ul li,.sa-md-ol li{margin:2px 0;}',
      '.sa-md-gap{height:5px;}',
      '.sa-md-code{background:rgba(127,127,127,.13);padding:8px 10px;border-radius:6px;overflow:auto;font-size:.92em;margin:0 0 8px;white-space:pre;}',
      '.sa-preview-body strong{font-weight:400;}',
      '.sa-preview-body b{font-weight:400;}',
      '.sa-preview-body .sa-md-p code,.sa-preview-body li code{background:rgba(127,127,127,.13);padding:1px 4px;border-radius:4px;font-size:.92em;}',
    ].join('')

    // GPT 产出的样式覆盖（handoff/superagent-panel-style/beautify.css），追加在后以覆盖基线
    const CSS_EXTRA = ".sa-page,\n.sa-page *,\n.sa-page *::before,\n.sa-page *::after,\n.sa-icon-wrap,\n.sa-icon-wrap *,\n[data-superagent-panel=\"dock\"],\n[data-superagent-panel=\"dock\"] * {\n  box-sizing: border-box;\n  font-weight: 400 !important;\n  font-synthesis: none;\n}\n\n.sa-page {\n  padding: 18px 20px;\n  color: currentColor;\n  font-size: 12.5px;\n  line-height: 1.5;\n}\n\n.sa-page .sa-head {\n  display: flex;\n  align-items: center;\n  flex-wrap: wrap;\n  gap: 8px 12px;\n}\n\n.sa-page .sa-head > .sa-title {\n  margin: 0;\n  font-size: 16.5px;\n  line-height: 1.5;\n  letter-spacing: .015em;\n}\n\n.sa-page .sa-sub {\n  margin: 6px 0 16px;\n  font-size: 12.5px;\n  line-height: 1.6;\n  opacity: .6;\n  overflow-wrap: anywhere;\n}\n\n.sa-page .sa-chips {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 6px;\n}\n\n.sa-page .sa-chip {\n  display: inline-flex;\n  align-items: center;\n  padding: 0 6px;\n  border: 1px solid rgba(127,127,127,.22);\n  border-radius: 3px;\n  background: rgba(127,127,127,.06) !important;\n  font-size: 12.5px;\n  line-height: 1.4;\n  white-space: nowrap;\n  font-variant-numeric: tabular-nums;\n}\n\n.sa-page [style*=\"156, 163, 175\"],\n.sa-page [style*=\"#9ca3af\"],\n[data-superagent-panel=\"dock\"] [style*=\"156, 163, 175\"],\n[data-superagent-panel=\"dock\"] [style*=\"#9ca3af\"] {\n  color: currentColor !important;\n  background: rgba(127,127,127,.12) !important;\n}\n\n.sa-page .sa-split {\n  display: flex;\n  align-items: flex-start;\n  gap: 14px;\n}\n\n.sa-page .sa-col-left {\n  flex: 1 1 0;\n  min-width: 0;\n  overflow-x: auto;\n  border: 1px solid rgba(127,127,127,.22);\n  border-radius: 4px;\n  scrollbar-width: thin;\n  scrollbar-color: rgba(127,127,127,.38) rgba(127,127,127,0);\n}\n\n.sa-page .sa-split.sa-with .sa-col-left {\n  flex: 56 1 0;\n  width: auto;\n}\n\n.sa-page .sa-table {\n  width: 100%;\n  min-width: 600px;\n  border-collapse: separate;\n  border-spacing: 0;\n  font-size: 12.5px;\n  line-height: 1.5;\n}\n\n.sa-page .sa-table th,\n.sa-page .sa-table td {\n  padding: 7px 10px;\n  border-bottom: 1px solid rgba(127,127,127,.12);\n  color: currentColor;\n  font-size: 12.5px;\n  line-height: 1.5;\n  text-align: left;\n  vertical-align: middle;\n}\n\n.sa-page .sa-table th {\n  padding-top: 8px;\n  padding-bottom: 8px;\n  background: rgba(127,127,127,.07);\n  opacity: 1;\n  white-space: nowrap;\n}\n\n.sa-page .sa-table th:nth-child(-n+5) { width: 1%; }\n.sa-page .sa-table tbody tr:last-child td { border-bottom: 0; }\n.sa-page .sa-table td.sa-title {\n  margin: 0;\n  font-size: 12.5px;\n  line-height: 1.5;\n  letter-spacing: normal;\n  overflow-wrap: anywhere;\n}\n\n.sa-page .sa-row { cursor: pointer; }\n.sa-page .sa-row:hover { background: rgba(127,127,127,.07); }\n.sa-page .sa-row.sa-on {\n  background: rgba(127,127,127,.12);\n  box-shadow: inset 2px 0 0 #3b82f6;\n}\n.sa-page .sa-row.sa-on:hover { background: rgba(127,127,127,.16); }\n.sa-page .sa-id { opacity: .85; white-space: nowrap; font-variant-numeric: tabular-nums; }\n.sa-page .sa-muted { opacity: .65; white-space: nowrap; font-variant-numeric: tabular-nums; }\n.sa-page .sa-ev-yes { color: #22c55e; white-space: nowrap; text-underline-offset: 3px; }\n.sa-page .sa-ev-no { opacity: .45; white-space: nowrap; }\n\n.sa-page .sa-col-right {\n  position: sticky;\n  top: 8px;\n  flex: 44 1 0;\n  min-width: 320px;\n  border: 1px solid rgba(127,127,127,.22);\n  border-radius: 4px;\n  overflow: hidden;\n  background: rgba(127,127,127,.025);\n}\n\n.sa-page .sa-preview-head {\n  display: flex;\n  align-items: center;\n  flex-wrap: wrap;\n  gap: 6px;\n  padding: 7px 10px;\n  border-bottom: 1px solid rgba(127,127,127,.18);\n  background: rgba(127,127,127,.06);\n  font-size: 12.5px;\n  line-height: 1.5;\n}\n\n.sa-page .sa-preview-head .sa-hint {\n  min-width: 0;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n.sa-page .sa-preview-body {\n  max-height: calc(100vh - 210px);\n  max-height: max(180px, calc(100dvh - 210px));\n  overflow: auto;\n  overscroll-behavior: contain;\n  scrollbar-width: thin;\n  scrollbar-color: rgba(127,127,127,.38) rgba(127,127,127,0);\n  padding: 18px;\n  font-size: 12.5px;\n  line-height: 1.65;\n  overflow-wrap: anywhere;\n}\n\n.sa-page .sa-btn {\n  padding: 3px 8px;\n  border: 1px solid rgba(127,127,127,.28);\n  border-radius: 3px;\n  background: rgba(127,127,127,0);\n  color: currentColor;\n  font: inherit;\n  font-size: 12.5px;\n  line-height: 1.5;\n  white-space: nowrap;\n  cursor: pointer;\n}\n\n.sa-page .sa-btn:hover {\n  border-color: rgba(127,127,127,.5);\n  background: rgba(127,127,127,.08);\n}\n.sa-page .sa-btn:active { background: rgba(127,127,127,.14); }\n.sa-page .sa-btn:focus-visible,\n.sa-page .sa-ev-yes:focus-visible { outline: 2px solid #3b82f6; outline-offset: 2px; }\n.sa-page .sa-hint { font-size: 12.5px; opacity: .6; }\n.sa-page .sa-empty { padding: 24px 12px; font-size: 12.5px; opacity: .6; }\n.sa-page .sa-toast { margin: 0 0 12px; color: #22c55e; font-size: 12.5px; overflow-wrap: anywhere; }\n\n.sa-page .sa-md-h {\n  margin: 20px 0 8px;\n  line-height: 1.5;\n  letter-spacing: normal;\n}\n.sa-page .sa-md-h1 {\n  padding-bottom: 8px;\n  border-bottom: 1px solid rgba(127,127,127,.16);\n  font-size: 16.5px;\n}\n.sa-page .sa-md-h2 { font-size: 14.5px; }\n.sa-page .sa-md-h3 { font-size: 13.25px; }\n.sa-page .sa-md-p { margin: 0 0 10px; white-space: pre-wrap; }\n.sa-page .sa-md-ul,\n.sa-page .sa-md-ol { margin: 0 0 10px; padding-left: 20px; }\n.sa-page .sa-md-ul li,\n.sa-page .sa-md-ol li { margin: 4px 0; }\n.sa-page .sa-md-gap { height: 6px; }\n.sa-page .sa-preview-body strong,\n.sa-page .sa-preview-body b { text-decoration: none; }\n.sa-page .sa-preview-body > :first-child { margin-top: 0; }\n.sa-page .sa-preview-body > :last-child { margin-bottom: 0; }\n\n.sa-page .sa-md-code,\n.sa-page .sa-preview-body code {\n  border-radius: 3px;\n  background: rgba(127,127,127,.1);\n  color: currentColor;\n  font-family: ui-monospace, SFMono-Regular, Consolas, \"Liberation Mono\", monospace;\n  font-size: .92em;\n  line-height: 1.6;\n}\n\n.sa-page .sa-md-code {\n  margin: 0 0 12px;\n  padding: 10px 12px;\n  border: 1px solid rgba(127,127,127,.16);\n  overflow: auto;\n  white-space: pre;\n  overflow-wrap: normal;\n  tab-size: 2;\n}\n\n.sa-page .sa-preview-body .sa-md-p code,\n.sa-page .sa-preview-body li code,\n.sa-page .sa-preview-body .sa-md-h code {\n  padding: 1px 4px;\n  background: rgba(127,127,127,.1);\n  font-size: .92em;\n}\n.sa-page .sa-md-code code { padding: 0; background: rgba(127,127,127,0); font-size: inherit; }\n\n.sa-icon-wrap { position: relative; display: inline-flex; align-items: center; justify-content: center; }\n.sa-icon-wrap .sa-badge {\n  position: absolute;\n  top: -6px;\n  right: -7px;\n  min-width: 16px;\n  height: 16px;\n  padding: 0 4px;\n  border: 1px solid currentColor;\n  border-radius: 4px;\n  background: rgba(127,127,127,.12);\n  color: #ef4444;\n  font-size: 10px;\n  line-height: 14px;\n  text-align: center;\n  font-variant-numeric: tabular-nums;\n  box-shadow: none;\n}\n\n[data-superagent-panel=\"dock\"] {\n  border-radius: 4px !important;\n  font-size: 12.5px !important;\n  line-height: 1.5 !important;\n}\n\n@media (max-width: 1000px) {\n  .sa-page .sa-split { flex-direction: column; }\n  .sa-page .sa-col-left,\n  .sa-page .sa-split.sa-with .sa-col-left,\n  .sa-page .sa-col-right { flex: 0 1 auto; width: 100%; min-width: 0; }\n  .sa-page .sa-col-right { position: static; }\n}\n\n@media (max-width: 540px) {\n  .sa-page { padding: 12px; }\n  .sa-page .sa-preview-body { padding: 14px; }\n}\n\n/*\n对应效果图的 56:44 分栏、细边框与 4px 小圆角；收起预览后表格铺满。\n紧凑行距、灰色选中底与蓝色竖线对应图中焦点；语义色只用于状态和交互。\n全域常规字重，正文 12.5px、代码 .92em；Markdown 以字号和段间留白建立层级。\n*/\n"

    function useStyleOnce() {
      useEffect(() => {
        if (document.querySelector('style[data-plugin="superagent-panel"]')) return
        const el = document.createElement('style')
        el.dataset.plugin = 'superagent-panel'
        el.textContent = CSS + CSS_EXTRA
        document.head.appendChild(el)
        return () => {}
      }, [])
    }

    function useTickets() {
      const [data, setData] = useState(null)
      const [dead, setDead] = useState(false)
      useEffect(() => {
        let alive = true
        const pull = async () => {
          try {
            const res = await fetch('/superagent/tickets', { headers: { accept: 'application/json' } })
            if (!res.ok) throw new Error('HTTP ' + res.status)
            const body = await res.json()
            if (alive) { setData(body); setDead(false) }
          } catch { if (alive) setDead(true) }
        }
        void pull()
        const timer = setInterval(() => { void pull() }, POLL_MS)
        // panel37：动作落地后立刻刷新，不必等下一次轮询
        const onRefresh = () => { void pull() }
        try { window.addEventListener('superagent:refresh', onRefresh) } catch (e) {}
        return () => { alive = false; clearInterval(timer); try { window.removeEventListener('superagent:refresh', onRefresh) } catch (e) {} }
      }, [])
      return { data, dead }
    }

    const reveal = async (ticketId) => {
      try {
        const res = await fetch('/superagent/reveal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticketId }) })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status))
        return { ok: true, path: body.path }
      } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) } }
    }

    // 手动结档：只提交命令（lite 的 tick 会按状态机收口），面板不直接改状态
    const closeTicket = async (ticketId) => {
      try {
        const res = await fetch('/superagent/close', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticketId }) })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status))
        return { ok: true, queued: !!body.queued }
      } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) } }
    }

    // 归档查询：只在 panel host 里读 archive/<前缀>.json
    const searchArchive = async (q) => {
      try {
        const res = await fetch('/superagent/archive?q=' + encodeURIComponent(q || ''))
        const body = await res.json().catch(() => ({}))
        if (!res.ok || body.ok !== true) throw new Error(body.error || ('HTTP ' + res.status))
        return { ok: true, rows: Array.isArray(body.rows) ? body.rows : [], total: Number(body.total || 0), returned: Number(body.returned || 0), hasMore: body.hasMore === true }
      } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) } }
    }

    // panel27（#68）：归档证据 —— 列文件 / 读正文 / 回滚（回滚只写 commands 队列，由 lite 搬回）
    const listArchEvidence = async (ticketId) => {
      try {
        const res = await fetch('/superagent/archive/evidence?ticketId=' + encodeURIComponent(ticketId))
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status))
        return { ok: true, files: Array.isArray(body.files) ? body.files : [] }
      } catch (e) { return { ok: false, files: [], error: String(e && e.message ? e.message : e) } }
    }
    const readArchEvidence = async (ticketId, file) => {
      try {
        const res = await fetch('/superagent/archive/evidence?ticketId=' + encodeURIComponent(ticketId) + '&file=' + encodeURIComponent(file))
        const body = await res.json().catch(() => ({}))
        if (!res.ok || body.ok === false) throw new Error(body.error || ('HTTP ' + res.status))
        return { ok: true, doc: body }
      } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) } }
    }
    // sa-187/P03：读归档判词（archive/verdicts/<id>.md），404 由调用方提示「该单无判词」
    const readArchVerdict = async (ticketId) => {
      try {
        const res = await fetch('/superagent/archive/verdict?ticketId=' + encodeURIComponent(ticketId))
        const body = await res.json().catch(() => ({}))
        if (res.status === 404 || body.error === 'no-verdict') return { ok: false, noVerdict: true, error: 'no-verdict' }
        if (!res.ok || body.ok === false) throw new Error(body.error || ('HTTP ' + res.status))
        return { ok: true, doc: body }
      } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) } }
    }
    // panel32：单张归档（面板只写命令，由 lite49 的 tick 搬进 archive）
    const postArchiveOne = async (ticketId) => {
      try {
        const res = await fetch('/superagent/archive-one', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticketId }) })
        const body = await res.json().catch(() => ({}))
        if (!res.ok || body.ok !== true) throw new Error(body.hint || body.error || ('HTTP ' + res.status))
        return { ok: true, doc: body }
      } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) } }
    }

    // v37：错误单「重跑」—— blocked → queued（只写命令队列，由 lite 按状态机重排）
    const postRequeue = async (ticketId) => {
      try {
        const res = await fetch('/superagent/requeue', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticketId }) })
        const body = await res.json().catch(() => ({}))
        if (!res.ok || body.ok === false) throw new Error(body.error || ('HTTP ' + res.status))
        return { ok: true, doc: body }
      } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) } }
    }
    const postRollback = async (payload) => {
      try {
        const res = await fetch('/superagent/rollback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}) })
        const body = await res.json().catch(() => ({}))
        if (!res.ok || body.ok === false) throw new Error(body.error || ('HTTP ' + res.status))
        return { ok: true, doc: body }
      } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) } }
    }

    // 统计页：host 从 state.json 现算
    const fetchStats = async () => {
      try {
        const res = await fetch('/superagent/stats')
        const body = await res.json().catch(() => ({}))
        if (!res.ok || body.ok === false) throw new Error(body.error || ('HTTP ' + res.status))
        return { ok: true, stats: body }
      } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) } }
    }

    // panel25：设置页（读写 settings.json）
    const fetchSettings = async () => {
      try {
        const res = await fetch('/superagent/settings')
        const body = await res.json().catch(() => ({}))
        if (!res.ok || body.ok === false) throw new Error(body.error || ('HTTP ' + res.status))
        return { ok: true, doc: body }
      } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) } }
    }
    const fetchDiagnostics = async () => {
      try {
        const res = await fetch('/superagent/diagnostics')
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status))
        return { ok: true, doc: body }
      } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) } }
    }
    const postMonitor = async (action) => {
      try {
        const res = await fetch('/superagent/monitor/' + action, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        const body = await res.json().catch(() => ({}))
        return { ok: res.ok && body.ok !== false, doc: body, error: body.error || ('HTTP ' + res.status) }
      } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) } }
    }
    const fetchOwnersDoc = async () => {
      try {
        const res = await fetch('/superagent/owners')
        const body = await res.json().catch(() => ({}))
        return { ok: true, doc: body }
      } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) } }
    }
    const postSettings = async (patch) => {
      try {
        const res = await fetch('/superagent/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
        const body = await res.json().catch(() => ({}))
        if (!res.ok || body.ok === false) throw new Error(body.error || ('HTTP ' + res.status))
        return { ok: true, doc: body }
      } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) } }
    }

    // ------------------------------------------------ 极简 Markdown → React
    let inlineKey = 0
    const inline = (s) => {
      const parts = []
      const re = /(\x60[^\x60]+\x60|\*\*[^*]+\*\*)/g
      let last = 0, m
      while ((m = re.exec(s))) {
        if (m.index > last) parts.push(s.slice(last, m.index))
        const tok = m[0]
        if (tok.charAt(0) === '\x60') parts.push(h('code', { key: 'i' + (inlineKey++) }, tok.slice(1, -1)))
        else parts.push(h('strong', { key: 'i' + (inlineKey++) }, tok.slice(2, -2)))
        last = m.index + tok.length
      }
      if (last < s.length) parts.push(s.slice(last))
      return parts.length ? parts : [s]
    }
    const isBlockStart = (l) => /^(#{1,6}\s|>|\x60\x60\x60)/.test(l) || /^\s*[-*]\s+/.test(l) || /^\s*\d+[.)]\s+/.test(l)
    function renderMarkdown(text) {
      const lines = String(text || '').split(/\r?\n/)
      const out = []
      let i = 0, k = 0
      while (i < lines.length) {
        const line = lines[i]
        if (/^\x60\x60\x60/.test(line)) {
          const buf = []
          i++
          while (i < lines.length && !/^\x60\x60\x60/.test(lines[i])) { buf.push(lines[i]); i++ }
          i++
          out.push(h('pre', { key: 'b' + (k++), className: 'sa-md-code' }, buf.join('\n')))
          continue
        }
        const hm = /^(#{1,6})\s+(.*)$/.exec(line)
        if (hm) {
          const lvl = Math.min(3, hm[1].length)
          out.push(h('div', { key: 'h' + (k++), className: 'sa-md-h sa-md-h' + lvl }, inline(hm[2])))
          i++
          continue
        }
        if (/^\s*[-*]\s+/.test(line)) {
          const items = []
          while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
            const m2 = /^\s*[-*]\s+(.*)$/.exec(lines[i])
            items.push(h('li', { key: 'l' + (k++) }, inline(m2[1])))
            i++
          }
          out.push(h('ul', { key: 'u' + (k++), className: 'sa-md-ul' }, items))
          continue
        }
        if (/^\s*\d+[.)]\s+/.test(line)) {
          const items = []
          while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
            const m2 = /^\s*\d+[.)]\s+(.*)$/.exec(lines[i])
            items.push(h('li', { key: 'l' + (k++) }, inline(m2[1])))
            i++
          }
          out.push(h('ol', { key: 'o' + (k++), className: 'sa-md-ol' }, items))
          continue
        }
        if (line.trim() === '') { i++; continue }
        const buf = [line]
        i++
        while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i])) { buf.push(lines[i]); i++ }
        out.push(h('p', { key: 'p' + (k++), className: 'sa-md-p' }, inline(buf.join('\n'))))
      }
      return out.length ? out : [h('div', { key: 'none', className: 'sa-md-p', style: { opacity: .5 } }, '（空文件）')]
    }

    // 找侧栏里「工单」这一行的容器（比图标宽、含这三个字）
    function findRow(wrap) {
      let row = wrap.parentElement
      for (let i = 0; i < 6 && row; i++) {
        const rr = row.getBoundingClientRect()
        if (String(row.textContent || '').indexOf('工单') >= 0 && rr.width > 120) return row
        row = row.parentElement
      }
      return null
    }

    function SidebarIcon() {
      const { data } = useTickets()
      const active = data ? Number(data.active || 0) : 0
      const wrapRef = useRef(null)

      // 未读角标直接插进这一行（row 的最后一个 flex 子项 + margin-left:auto 顶到右端），
      // 竖直方向交给行自己的 align-items 居中 —— 数字和「工单」自然同一中线，不靠算坐标。
      useLayoutEffect(() => {
        const wrap = wrapRef.current
        if (!wrap) return
        let badge = null
        const ensure = () => {
          const row = findRow(wrap)
          if (!row) return
          if (!badge || badge.parentElement !== row) {
            if (badge) { try { badge.remove() } catch {} }
            const cs = getComputedStyle(row)
            if (cs.display !== 'flex' && cs.display !== 'inline-flex') {
              row.style.display = 'flex'
              row.style.alignItems = 'center'
            }
            // 2026-11-07：角标改绝对定位后需要一个定位参照，否则会相对更外层容器跑偏。
            if (getComputedStyle(row).position === 'static') row.style.position = 'relative'
            const el = document.createElement('span')
            el.setAttribute('data-sa-unread', '1')
            el.style.cssText = 'position:absolute;right:6px;top:50%;transform:translateY(-50%);flex:0 0 auto;border-radius:999px;background:#f59e0b;color:#fff;text-align:center;font-variant-numeric:tabular-nums;box-shadow:0 0 0 1px rgba(0,0,0,.16);pointer-events:none;box-sizing:border-box;'
            row.appendChild(el)
            badge = el
          }
          // 一位数：14px 圆 + 9px 字；99+ 三位数：放大到 16px 高 + 10.5px 字（用户反馈 9px 看不清）
          const big = active > 99
          const box = big ? 16 : 14
          const fs = big ? 10.5 : 9
          const pad = big ? 4 : 3
          badge.style.minWidth = box + 'px'
          badge.style.height = box + 'px'
          badge.style.lineHeight = box + 'px'
          badge.style.padding = '0 ' + pad + 'px'
          badge.style.fontSize = fs + 'px'
          badge.textContent = big ? '99+' : String(active)
          badge.style.display = active > 0 ? '' : 'none'
        }
        ensure()
        const t1 = setTimeout(ensure, 300)
        const t2 = setTimeout(ensure, 1200)
        return () => {
          clearTimeout(t1); clearTimeout(t2)
          if (badge) { try { badge.remove() } catch {} }
        }
      }, [active])

      return h('span', { className: 'sa-icon-wrap', ref: wrapRef },
        h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
          h('rect', { x: 4, y: 4, width: 16, height: 16, rx: 3 }),
          h('path', { d: 'M8 10h8' }),
          h('path', { d: 'M8 14h5' }),
        ),
      )
    }

    function Preview({ ticket, onReveal, onClose, tick }) {
      const [state, setState] = useState({ loading: false, text: '', path: '', error: '', truncated: false })
      const [nonce, setNonce] = useState(0)
      const id = ticket ? ticket.id : ''
      const hasEv = !!(ticket && ticket.evidence)

      useEffect(() => {
        if (!hasEv) { setState({ loading: false, text: '', path: '', error: '', truncated: false }); return }
        let alive = true
        setState((s) => ({ ...s, loading: true, error: '' }))
        fetch('/superagent/evidence?ticketId=' + encodeURIComponent(id))
          .then(async (res) => {
            const body = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status))
            if (alive) setState({ loading: false, text: body.text || '', path: body.path || '', error: '', truncated: !!body.truncated })
          })
          .catch((e) => { if (alive) setState({ loading: false, text: '', path: '', error: String(e && e.message ? e.message : e), truncated: false }) })
        return () => { alive = false }
      }, [id, hasEv, nonce, tick])

      return h('div', { className: 'sa-col-right' },
        h('div', { className: 'sa-preview-head' },
          h('span', { style: { fontWeight: 600, flex: '0 0 auto' } }, ticket.id),
          h('span', { className: 'sa-hint', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 } }, state.path || '…'),
          h('button', { className: 'sa-btn', onClick: () => setNonce((n) => n + 1) }, state.loading ? '读取中…' : '刷新'),
          h('button', { className: 'sa-btn', onClick: () => onReveal(ticket.id) }, '定位文件'),
          h('button', { className: 'sa-btn', onClick: onClose }, '收起'),
        ),
        h('div', { className: 'sa-who', style: { borderBottom: '1px solid rgba(127,127,127,.2)', padding: '8px 11px', display: 'grid', gridTemplateColumns: '54px 1fr', gap: '3px 10px', fontSize: 11.5, lineHeight: 1.5 } },
          h('span', { className: 'sa-hint' }, '派单'),
          h('span', null, ticket.creator || '—'),
          h('span', { className: 'sa-hint' }, '执行'),
          h('span', null, (ticket.backend || '—') + (ticket.assignees && ticket.assignees.length ? ' · ' + ticket.assignees.map((a) => a.who + (a.status === 'reported' ? '(已交)' : '')).join(' / ') : '')),
          h('span', { className: 'sa-hint' }, '自报'),
          h('span', null, ticket.reports && ticket.reports.count ? (ticket.reports.count + ' 条 · ' + String((ticket.reports.last && ticket.reports.last.summary) || '').slice(0, 60)) : '—'),
          h('span', { className: 'sa-hint' }, '验收'),
          h('span', null, ticket.verdict ? ((ticket.verdict.by || 'judge') + ' · ' + (ticket.verdict.pass ? '通过' : '不通过') + ' · ' + String(ticket.verdict.at || '').slice(11, 16)) : (ticket.judge ? (ticket.judge.who + ' · ' + ticket.judge.status) : '—')),
          ticket.verdict && ticket.verdict.reason ? h('span', { className: 'sa-hint' }, '理由') : null,
          ticket.verdict && ticket.verdict.reason ? h('span', { style: { opacity: .8 } }, String(ticket.verdict.reason).slice(0, 160) + (String(ticket.verdict.reason).length > 160 ? '…' : '')) : null,
          h('span', { className: 'sa-hint' }, '结档'),
          h('span', null, ticket.manualClose ? '手动结档' : (ticket.state === 'done' ? '正常验收' : '—')),
        ),
        !hasEv
          ? h('div', { className: 'sa-preview-body', style: { opacity: .55 } }, '这张工单没有证据文件（watchdog 的 done-no-artifact 会报它）。')
          : state.error
            ? h('div', { className: 'sa-preview-body', style: { color: '#ef4444' } }, '读不到：' + state.error)
            : h('div', { className: 'sa-preview-body' }, ...renderMarkdown(state.loading ? '读取中…' : state.text)),
        state.truncated ? h('div', { className: 'sa-preview-head', style: { borderTop: '1px solid rgba(127,127,127,.2)', borderBottom: 'none', opacity: .6 } }, '文件太大，只显示前 256 KB') : null,
      )
    }

    function MainPage() {
      useStyleOnce()
      const { data, dead } = useTickets()
      const [selId, setSelId] = useState(null)
      const [toast, setToast] = useState('')
      const [previewTick, setPreviewTick] = useState(0)
      const [archQ, setArchQ] = useState('')
      const [archRows, setArchRows] = useState(null)
      const [archTotal, setArchTotal] = useState(0)
      const [archHasMore, setArchHasMore] = useState(false)
      const [archEvId, setArchEvId] = useState('')   // panel27(#68)：展开证据的归档单
      const [archFiles, setArchFiles] = useState({}) // panel27：id -> 该单在 archive/evidence/ 下的文件
      const [archDoc, setArchDoc] = useState(null)   // panel27：当前查看的归档证据正文
      const [rbArmed, setRbArmed] = useState(false)  // panel27：回滚全部要先点两次

      const [tab, setTab] = useState('tickets')
      const [stats, setStats] = useState(null)
      const [stDoc, setStDoc] = useState(null)
      const [stDraft, setStDraft] = useState({})
      // sa-196：设置页升级
      const [diag, setDiag] = useState(null)
      const [diagBusy, setDiagBusy] = useState(false)
      const [ownersDoc, setOwnersDoc] = useState(null)
      const [monitorMsg, setMonitorMsg] = useState('')
      const [view, setView] = useState('table')
      const [fType, setFType] = useState('all')
      const [fBackend, setFBackend] = useState('all')
      const [fRange, setFRange] = useState('all')
      const [tq, setTq] = useState('')  // panel31：工单页文本搜索（编号 / 标题 / 类型词）
      const [batchOn, setBatchOn] = useState(false)   // panel37：批量模式（表格+看板共用）
      const [selIds, setSelIds] = useState([])
      const [abatchOn, setAbatchOn] = useState(false) // panel37：归档页批量模式
      const [aselIds, setAselIds] = useState([])

      const flash = (msg) => { setToast(msg); setTimeout(() => setToast(''), 2600) }
      // panel37：命令落地约 0.5s，再触发一次即时刷新（轮询 1.5s 兜底）
      const refreshNow = (ms) => { setTimeout(() => { try { window.dispatchEvent(new Event('superagent:refresh')) } catch (e) {} }, ms == null ? 600 : ms) }
      const onReveal = async (id) => {
        const r = await reveal(id)
        flash(r.ok ? '已在资源管理器里选中：' + r.path : '定位失败：' + r.error)
      }
      const onArchive = async () => {
        setArchRows([])
        const r = await searchArchive(archQ)
        if (!r.ok) { flash('归档查询失败：' + r.error); setArchRows(null); return }
        setArchRows(r.rows)
        setArchTotal(r.total)
        setArchHasMore(r.hasMore)
      }
      const toDraft = (s) => {
        const p = (s && s.pruneCaps) || {}
        return {
          timeoutMin: String(Math.round((s && s.runningTimeoutMs ? s.runningTimeoutMs : 300000) / 60000)),
          deliver: String((s && s.maxDeliverAttempts) || 30),
          capMb: String(Math.round(((s && s.attachMaxBytes) || 8388608) / 1048576)),
          watchdog: !(s && s.watchdogAlerts === false),
          evidence: !(s && s.errorEvidence === false),
          autoDispatch: !(s && s.autoDispatch === false),
          autoMs: String((s && s.autoDispatchMs) || 15000),
          outboxMax: String(p.outboxMax == null ? 500 : p.outboxMax),
          outboxDays: String(p.outboxKeepDays == null ? 7 : p.outboxKeepDays),
          abandonedDays: String(p.abandonedKeepDays == null ? 3 : p.abandonedKeepDays),
          historyMax: String(p.historyMax == null ? 100 : p.historyMax),
          artifactMax: String(p.artifactMax == null ? 200 : p.artifactMax),
          reportMax: String(p.reportMax == null ? 50 : p.reportMax),
          // sa-196：新键
          autoJudge: s && s.autoJudge === true ? 'true' : (typeof (s && s.autoJudge) === 'string' ? s.autoJudge : 'false'),
          judgeRotate: !(s && s.judgeRotate === false),
          notifyReadyTo: (s && s.notifyReadyTo) || 'judge',
          quietSources: Array.isArray(s && s.quietSources) ? s.quietSources.join(',') : '',
          deliverOutMode: (s && s.deliverOut && s.deliverOut.mode) || 'off',
          deliverOutApi: (s && s.deliverOut && s.deliverOut.apiBase) || 'http://127.0.0.1:3001',
          docJudge: !(s && s.docJudge === false),
          docCriteria: Array.isArray(s && s.docCriteria) ? s.docCriteria.join('\n') : '',
          neVerdictFail: !(s && s.notifyEvents && s.notifyEvents.verdictFail === false),
          neWatchdog: !(s && s.notifyEvents && s.notifyEvents.watchdog === false),
          neDeliverFailed: !(s && s.notifyEvents && s.notifyEvents.deliverFailed === false),
          neDocDone: !(s && s.notifyEvents && s.notifyEvents.docDone === false),
          refreshMs: String((s && s.refreshMs) || 1500),
          defaultTab: (s && s.defaultTab) || 'tickets',
          theme: (s && s.theme) || 'auto',
          cmEnabled: !!(s && s.ctxMonitor && s.ctxMonitor.enabled),
          cmInterval: String((s && s.ctxMonitor && s.ctxMonitor.intervalSec) || 60),
          cmOfficial: String((s && s.ctxMonitor && s.ctxMonitor.thresholdOfficial) || 65),
          cmOther: String((s && s.ctxMonitor && s.ctxMonitor.thresholdOther) || 85),
          cmThresholds: Array.isArray(s && s.ctxMonitor && s.ctxMonitor.thresholds) ? (s.ctxMonitor.thresholds || []).map((x) => x.provider + '=' + x.pct).join('\n') : '',
          cmAlertIngress: !(s && s.ctxMonitor && s.ctxMonitor.alertIngress === false),
        }
      }
      const loadSettings = async () => {
        const r = await fetchSettings()
        if (!r.ok) { flash('读设置失败：' + r.error); return }
        setStDoc(r.doc)
        setStDraft(toDraft(r.doc.settings))
      }
      const saveSettings = async () => {
        const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d }
        const payload = {
          runningTimeoutMs: Math.round(num(stDraft.timeoutMin, 5) * 60000),
          maxDeliverAttempts: Math.round(num(stDraft.deliver, 30)),
          attachMaxBytes: Math.round(num(stDraft.capMb, 8) * 1048576),
          watchdogAlerts: !!stDraft.watchdog,
          errorEvidence: !!stDraft.evidence,
          autoDispatch: !!stDraft.autoDispatch,
          autoDispatchMs: Math.round(num(stDraft.autoMs, 15000)),
          pruneCaps: {
            outboxMax: Math.round(num(stDraft.outboxMax, 500)),
            outboxKeepDays: Math.round(num(stDraft.outboxDays, 7)),
            abandonedKeepDays: Math.round(num(stDraft.abandonedDays, 3)),
            historyMax: Math.round(num(stDraft.historyMax, 100)),
            artifactMax: Math.round(num(stDraft.artifactMax, 200)),
            reportMax: Math.round(num(stDraft.reportMax, 50)),
          },
          // sa-196：新键
          autoJudge: stDraft.autoJudge === 'true' ? true : (stDraft.autoJudge === 'false' || !stDraft.autoJudge ? false : String(stDraft.autoJudge)),
          judgeRotate: !!stDraft.judgeRotate,
          notifyReadyTo: stDraft.notifyReadyTo || 'judge',
          quietSources: String(stDraft.quietSources || '').split(',').map((x) => x.trim()).filter(Boolean),
          deliverOut: stDraft.deliverOutMode === 'off' ? null : { mode: 'onebot', apiBase: String(stDraft.deliverOutApi || 'http://127.0.0.1:3001').trim() },
          docJudge: !!stDraft.docJudge,
          docCriteria: String(stDraft.docCriteria || '').split('\n').map((x) => x.trim()).filter(Boolean),
          notifyEvents: { verdictFail: !!stDraft.neVerdictFail, watchdog: !!stDraft.neWatchdog, deliverFailed: !!stDraft.neDeliverFailed, docDone: !!stDraft.neDocDone },
          refreshMs: Math.round(num(stDraft.refreshMs, 1500)),
          defaultTab: stDraft.defaultTab || 'tickets',
          theme: stDraft.theme || 'auto',
          ctxMonitor: {
            enabled: !!stDraft.cmEnabled,
            intervalSec: Math.round(num(stDraft.cmInterval, 60)),
            thresholdOfficial: num(stDraft.cmOfficial, 65),
            thresholdOther: num(stDraft.cmOther, 85),
            thresholds: String(stDraft.cmThresholds || '').split('\n').map((x) => x.trim()).filter(Boolean).map((x) => { const i = x.lastIndexOf('='); return i > 0 ? { provider: x.slice(0, i).trim(), pct: Number(x.slice(i + 1)) } : null }).filter((x) => x && x.provider && Number.isFinite(x.pct)),
            alertIngress: !!stDraft.cmAlertIngress,
          },
        }
        const r = await postSettings(payload)
        if (!r.ok) { flash('保存失败：' + r.error); return }
        setStDoc(r.doc)
        setStDraft(toDraft(r.doc.settings))
        flash('已保存，全部热生效（内核/面板按 mtime 读取，不用重启）')
        void runDiag()
      }
      const runDiag = async () => {
        setDiagBusy(true)
        const r = await fetchDiagnostics()
        setDiagBusy(false)
        if (!r.ok) { flash('体检失败：' + r.error); return }
        setDiag(r.doc)
      }
      const loadOwnersDoc = async () => {
        const r = await fetchOwnersDoc()
        if (r.ok) setOwnersDoc(r.doc)
      }
      const onMonitor = async (action) => {
        const r = await postMonitor(action)
        const label = action === 'start' ? '启动' : action === 'stop' ? '停止' : '重启'
        if (!r.ok) { setMonitorMsg(label + '失败：' + (r.error || '')); flash('监测' + label + '失败：' + (r.error || '')); return }
        setMonitorMsg('监测已' + label + (r.doc && r.doc.pid ? '（pid ' + r.doc.pid + '）' : ''))
        flash('监测已' + label)
        void loadSettings()
        void runDiag()
      }
      const onStats = async () => {
        const r = await fetchStats()
        if (!r.ok) { flash('统计读取失败：' + r.error); return }
        setStats(r.stats)
      }
      const goTab = (k) => {
        setTab(k)
        if (k === 'archive') void onArchive()
        if (k === 'stats') void onStats()
        if (k === 'settings') {
          if (!stDoc) void loadSettings()
          void loadOwnersDoc()
          void runDiag()
        }
      }
      // panel37：批量勾选 / 批量归档 / 批量回滚（都只发命令，面板不直接改 state）
      const toggleSel = (id) => setSelIds((a) => (a.includes(id) ? a.filter((x) => x !== id) : a.concat(id)))
      const closedOf = (ids) => { const list = (data && data.tickets) || []; return ids.filter((id) => { const t = list.find((x) => x.id === id); return !!t && (t.state === 'done' || t.state === 'blocked') }) }
      const onBatchArchive = async () => {
        const ids = closedOf(selIds)
        if (!ids.length) { flash('没选到可归档的单（只有已完成 / 错误 的单能归档）'); return }
        let n = 0
        const errors = []
        for (const id of ids) { const r = await postArchiveOne(id); if (r.ok) n++; else errors.push(id + '：' + r.error) }
        flash('已提交批量归档 ' + n + ' 张' + (ids.length > n ? '（' + (ids.length - n) + ' 张没提交上）' : '') + '，约 1 秒后进「归档」页' + (errors.length ? '；失败：' + errors.join('；') : ''))
        setSelIds([])
        refreshNow(700)
      }
      const toggleASel = (id) => setAselIds((a) => (a.includes(id) ? a.filter((x) => x !== id) : a.concat(id)))
      const onBatchRestore = async () => {
        if (!aselIds.length) { flash('先勾选要回滚的归档单'); return }
        const r = await postRollback({ ids: aselIds })
        if (!r.ok) { flash('回滚失败：' + r.error); return }
        flash('已提交回滚 ' + r.doc.count + ' 张' + (r.doc.truncated ? '（达到 200 张上限，其余未提交）' : '') + '，约 1 秒后回「工单」页')
        setAselIds([]); setArchDoc(null)
        refreshNow(700)
        setTimeout(() => { void onArchive() }, 900)
      }
      const onRequeue = async (id) => {
        const r = await postRequeue(id)
        flash(r.ok ? '已提交重跑：' + id + '（约 1 秒回到「排队」）' : '重跑失败：' + r.error)
        if (r.ok) refreshNow(700)
      }
      const onArchiveOne = async (id) => {
        const r = await postArchiveOne(id)
        flash(r.ok ? '已提交归档：' + id + '（约 1 秒搬进「归档」页）' : '归档失败：' + r.error)
        if (r.ok) refreshNow(700)
      }
      const onClose = async (id) => {
        const r = await closeTicket(id)
        flash(r.ok ? '已提交结档：' + id + '（约 1 秒收口）' : '结档失败：' + r.error)
        if (r.ok) refreshNow(700)
      }

      const onArchFiles = async (id) => {
        if (archEvId === id) { setArchEvId(''); return }
        setArchEvId(id)
        if (archFiles[id]) return
        const r = await listArchEvidence(id)
        if (!r.ok) { flash('读归档证据列表失败：' + r.error); return }
        setArchFiles((m) => ({ ...m, [id]: r.files }))
      }
      const archSeq = { n: 0 }
      const onArchOpen = async (id, file) => {
        const seq = ++archSeq.n
        const r = await readArchEvidence(id, file)
        if (seq !== archSeq.n) return
        if (!r.ok) { flash('读证据失败：' + r.error); return }
        setArchDoc(r.doc)
      }
      // sa-187/P03：看归档判词 —— 正文进右侧预览，404 提示「该单无判词」
      const onArchVerdict = async (id) => {
        const seq = ++archSeq.n
        const r = await readArchVerdict(id)
        if (seq !== archSeq.n) return
        if (!r.ok) { flash(r.noVerdict ? '该单无判词' : '读判词失败：' + r.error); return }
        setArchDoc({ ok: true, ticketId: id, relative: 'archive/verdicts/' + id + '.md', text: r.doc.text || '' })
      }
      const onRollbackOne = async (id) => {
        const r = await postRollback({ ticketId: id })
        flash(r.ok ? '已排队回滚 ' + id + '（约 1 秒搬回「工单」页）' : '回滚失败：' + r.error)
        if (r.ok) { setAselIds([]); setArchEvId(''); refreshNow(700); setTimeout(() => { setArchDoc(null); void onArchive() }, 900) }
      }
      const onRollbackAll = async () => {
        if (!rbArmed) { setRbArmed(true); flash('再点一次「回滚全部」确认（本次最多提交 200 张归档单，实际数量以提交结果为准）'); return }
        setRbArmed(false)
        const r = await postRollback({ all: true })
        flash(r.ok ? '已提交回滚 ' + r.doc.count + ' 张' + (r.doc.truncated ? '（达到 200 张上限，其余未提交）' : '') + '（约 1 秒生效）' : '回滚失败：' + r.error)
        if (r.ok) { refreshNow(700); setTimeout(() => { setArchDoc(null); void onArchive() }, 900) }
      }

      if (dead) return h('div', { className: 'sa-page sa-empty' }, '读不到 /superagent/tickets（宿主端点或插件没挂上）')
      if (!data) return h('div', { className: 'sa-page sa-empty' }, '读取中…')

      const rows = data.tickets || []
      const counts = data.counts || {}
      const order = ['running', 'ready', 'queued', 'blocked', 'done']
      const TYPE_META = { test: { label: '测试', bg: '#8b5cf6' }, code: { label: '代码', bg: '#0ea5e9' }, office: { label: '办公', bg: '#db2777' } }
      const TYPE_FALLBACK = { label: '未标', bg: '#6b7280' }
      const typeLabel = (t) => { const m = TYPE_META[t]; return m ? m.label : '未标' }
      const numOf = (id) => { const m = String(id).match(/-(\d+)$/); return m ? Number(m[1]) : -1 }
      const rangeOf = (id) => { const n = numOf(id); if (n < 0) return 'na'; if (n <= 99) return '001-099'; if (n <= 199) return '100-199'; if (n <= 299) return '200-299'; return '300+' }
      const backendKey = (t) => (t.backend ? t.backend : 'none')
      // panel31：文本搜索先过一遍（编号 / 标题 / 类型中文名 / 类型英文名），再叠类型·后端·号段筛选
      const tqNorm = String(tq || '').trim().toLowerCase()
      const textHit = (t) => {
        if (!tqNorm) return true
        const hay = (String(t.id || '') + ' ' + String(t.title || '') + ' ' + typeLabel(t.type) + ' ' + String(t.type || '')).toLowerCase()
        return hay.includes(tqNorm)
      }
      const match = (t) => textHit(t) && (fType === 'all' || (t.type || '') === fType) && (fBackend === 'all' || backendKey(t) === fBackend) && (fRange === 'all' || rangeOf(t.id) === fRange)
      const viewRows = rows.filter(match)
      const backends = Array.from(new Set(rows.map(backendKey)))
      const ranges = ['001-099', '100-199', '200-299', '300+']
      const sel = viewRows.find((t) => t.id === selId) || null
      const fmtMs = (ms) => (ms == null ? '—' : ms < 60000 ? Math.round(ms / 1000) + 's' : (ms / 60000).toFixed(1) + 'min')

      const tabBtn = (key, label) => h('button', {
        key,
        className: 'sa-btn sa-tab' + (tab === key ? ' sa-tab-on' : ''),
        onClick: () => goTab(key),
        style: tab === key ? { borderColor: 'rgba(245,158,11,.75)', background: 'rgba(245,158,11,.14)' } : undefined,
      }, label)
      const seg = (key, label) => h('button', {
        key,
        className: 'sa-btn',
        onClick: () => setView(key),
        style: view === key ? { borderColor: 'rgba(59,130,246,.75)', background: 'rgba(59,130,246,.14)' } : undefined,
      }, label)
      const picker = (value, options, onChange, title) => h('select', {
        value,
        title,
        onChange: (ev) => onChange(ev.target.value),
        style: { fontSize: 12, padding: '3px 6px', borderRadius: 5, border: '1px solid rgba(127,127,127,.35)', background: 'transparent', color: 'inherit' },
      }, options.map((o) => h('option', { key: o.value, value: o.value, style: { color: '#111' } }, o.label)))
      const stateChips = h('div', { className: 'sa-chips' },
        ...order.filter((k) => counts[k]).map((k) => {
          const m = STATE_META[k]
          return h('span', { key: k, className: 'sa-chip', style: { color: m.color, background: m.bg } }, m.label + ' ' + counts[k])
        }),
      )

      const typeCell = (t, small) => { const m = TYPE_META[t.type] || TYPE_FALLBACK; return h('span', { className: 'sa-tchip', style: { display: 'inline-block', background: m.bg, color: '#fff', fontSize: small ? 10.5 : 11, lineHeight: small ? '16px' : '18px', padding: small ? '0 5px' : '0 7px', borderRadius: 4, whiteSpace: 'nowrap', fontWeight: 400, letterSpacing: '.02em' } }, m.label) }

      const statsView = stats
        ? h('div', { style: { border: '1px solid rgba(127,127,127,.28)', borderRadius: 8, padding: '12px 14px', background: 'rgba(127,127,127,.05)', maxWidth: 720 } },
          h('div', { className: 'sa-hint', style: { marginBottom: 10 } }, '当前 state.json 共 ' + stats.total + ' 张（归档的旧单在「归档」页按编号/标题查）'),
          h('div', { style: { display: 'grid', gridTemplateColumns: '96px 1fr', gap: '8px 12px', alignItems: 'start' } },
            h('div', { className: 'sa-hint' }, '状态'),
            h('div', null, ...Object.keys(stats.byState || {}).map((k) => {
              const m = STATE_META[k] || STATE_META.queued
              return h('span', { key: k, className: 'sa-chip', style: { color: m.color, background: m.bg, marginRight: 6 } }, m.label + ' ' + stats.byState[k])
            })),
            h('div', { className: 'sa-hint' }, '后端'),
            h('div', null, ...Object.keys(stats.byBackend || {}).map((k) => h('span', { key: k, className: 'sa-chip', style: { marginRight: 6 } }, k + ' ' + stats.byBackend[k]))),
            h('div', { className: 'sa-hint' }, '证据'),
            h('div', null, '有产物 ' + (stats.evidence || {}).withArtifacts + ' 张 · 产物共 ' + (stats.evidence || {}).artifactsTotal + ' 个 · 无产物 ' + (stats.evidence || {}).noArtifact + ' 张'),
            h('div', { className: 'sa-hint' }, '耗时'),
            h('div', null, '样本 ' + (stats.durations || {}).n + ' · 平均 ' + fmtMs((stats.durations || {}).avgMs) + ' · p50 ' + fmtMs((stats.durations || {}).p50Ms) + ' · 最长 ' + fmtMs((stats.durations || {}).maxMs)),
          ),
          h('div', { style: { marginTop: 10 } }, h('button', { className: 'sa-btn', onClick: onStats }, '刷新统计')),
        )
        : h('div', { className: 'sa-empty' }, '汇总 state.json 中…')

      const table = h('div', { className: 'sa-split' + (sel ? ' sa-with' : ''), style: { flex: 1, minHeight: 0, alignItems: 'flex-start' } },
        h('div', { className: 'sa-col-left' },
          // v30：滚轮修复 —— 同时给 flex 撑高和 calc 兜底，百分比解析失败也能滚
          h('div', { className: 'sa-table-wrap', style: { flex: 1, minHeight: 0, maxHeight: 'calc(100vh - 250px)', overflowY: 'auto', overflowX: 'auto', scrollbarWidth: 'thin', scrollbarGutter: 'stable' } },
          h('table', { className: 'sa-table' },
            h('thead', null, h('tr', null,
              h('th', { style: { width: 4, padding: 0 } }, ''),
              batchOn ? h('th', { style: { width: 24, padding: '8px 4px' } }, '') : null,
              h('th', null, '工单'), h('th', null, '状态'), h('th', null, '类型'), h('th', null, '后端'), h('th', null, '派单'),
              h('th', null, '距今'), h('th', null, '证据'), h('th', null, '操作'), h('th', null, '标题'),
            )),
            h('tbody', null, viewRows.map((t) => {
              const m = STATE_META[t.state] || STATE_META.queued
              return h('tr', {
                key: t.id,
                className: 'sa-row' + (selId === t.id ? ' sa-on' : ''),
                onClick: () => { setSelId(t.id); setPreviewTick((n) => n + 1) },
                title: '点一下在右侧看证据与参与人',
              },
                h('td', { style: { width: 4, padding: 0, background: m.color } }, ''),
                batchOn ? h('td', { style: { padding: '8px 4px' } }, h('input', { type: 'checkbox', checked: selIds.includes(t.id), disabled: !(t.state === 'done' || t.state === 'blocked'), title: (t.state === 'done' || t.state === 'blocked') ? '' : '只有已完成 / 错误 的单能批量归档', onClick: (ev) => ev.stopPropagation(), onChange: () => toggleSel(t.id) })) : null,
                h('td', { className: 'sa-id' }, t.id),
                h('td', null, h('span', { className: 'sa-chip', style: { color: m.color, background: m.bg } }, m.label)),
                h('td', null, typeCell(t)),
                h('td', { className: 'sa-muted' }, t.backend || '—'),
                h('td', { className: 'sa-muted', style: { maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: (t.creator || '—') + (t.sessionId ? '\n会话 ' + t.sessionId : '') }, t.creator || '—'),
                h('td', { className: 'sa-muted', title: ageTitle(t.ageMin) }, fmtAge(t.ageMin)),
                h('td', null, t.evidence
                  ? h('span', { className: 'sa-ev-yes', style: { cursor: 'pointer', textDecoration: 'underline dotted' }, title: t.evidence + (t.artifacts ? '（清单 ' + t.artifacts + ' 条）' : ''), onClick: (ev) => { ev.stopPropagation(); setSelId(t.id); onReveal(t.id) } }, t.artifacts ? '有 ' + t.artifacts + ' · 定位' : '有 · 定位')
                  : h('span', { className: 'sa-ev-no' }, '无')),
                h('td', null, ...(t.state === 'done'
                  ? [h('button', { className: 'sa-btn', title: '归档这张单：搬进「归档」页，证据一起走（可按编号/关键词再搜回来）', onClick: (ev) => { ev.stopPropagation(); void onArchiveOne(t.id) }, style: { background: '#5c4033', color: '#fff', border: 'none', padding: '1px 8px', fontSize: 11, lineHeight: '18px', borderRadius: 4, fontWeight: 400, whiteSpace: 'nowrap' } }, '归档')]
                  : [
                    t.state === 'blocked' ? h('button', { className: 'sa-btn', title: '重跑：blocked → queued，重新进派单池（原证据保留）', onClick: (ev) => { ev.stopPropagation(); void onRequeue(t.id) }, style: { borderColor: 'rgba(34,197,94,.75)', background: 'rgba(34,197,94,.14)', marginRight: 4 } }, '重跑') : null,
                    h('button', { className: 'sa-btn', title: '手动结档：直接置 done（会补一条说明作为证据）', onClick: (ev) => { ev.stopPropagation(); void onClose(t.id) } }, '结档'),
                  ])),
                h('td', { className: 'sa-title' }, t.title || ''),
              )
            })),
          ),
          ),
        ),
        sel ? h(Preview, { ticket: sel, onReveal, onClose: () => setSelId(null), tick: previewTick }) : null,
      )

      const KANBAN_COLS = [['queued', '排队'], ['running', '处理中'], ['ready', '待验收'], ['blocked', '错误']]
      const kcard = (t, width) => h('div', {
        key: t.id,
        style: { flex: width ? '0 0 ' + width + 'px' : '0 0 auto', width: width || 'auto', border: '1px solid rgba(127,127,127,.22)', borderRadius: 6, padding: '6px 8px', background: 'rgba(127,127,127,.05)', cursor: 'pointer', minWidth: 0 },
        onClick: () => { setSelId(t.id); setPreviewTick((n) => n + 1) },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
          batchOn ? h('input', { type: 'checkbox', checked: selIds.includes(t.id), disabled: !(t.state === 'done' || t.state === 'blocked'), onClick: (ev) => ev.stopPropagation(), onChange: () => toggleSel(t.id) }) : null,
          h('span', { className: 'sa-id' }, t.id),
          h('span', { style: { marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5 } }, typeCell(t, true), t.backend ? h('span', { className: 'sa-hint' }, t.backend) : null),
        ),
        h('div', { style: { margin: '3px 0 4px', fontSize: 12.5, lineHeight: 1.45, maxHeight: '2.9em', overflow: 'hidden' } }, t.title || ''),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, opacity: 0.85 } },
          h('span', null, fmtAge(t.ageMin)),
          h('span', null, '证据 ' + (t.artifacts || 0)),
          t.creator ? h('span', { style: { marginLeft: 'auto' } }, t.creator) : null,
          t.state !== 'done'
            ? h('span', { style: { display: 'inline-flex', gap: 4 } },
                t.state === 'blocked' ? h('button', { className: 'sa-btn', style: { padding: '1px 6px', fontSize: 11, borderColor: 'rgba(34,197,94,.75)', background: 'rgba(34,197,94,.14)' }, onClick: (ev) => { ev.stopPropagation(); void onRequeue(t.id) } }, '重跑') : null,
                h('button', { className: 'sa-btn', style: { padding: '1px 6px', fontSize: 11 }, onClick: (ev) => { ev.stopPropagation(); void onClose(t.id) } }, '结档'))
            : h('button', { className: 'sa-btn', style: { padding: '1px 6px', fontSize: 11, background: '#5c4033', color: '#fff', border: 'none', borderRadius: 4 }, onClick: (ev) => { ev.stopPropagation(); void onArchiveOne(t.id) } }, '归档'),
        ),
      )
      const colHead = (label, color, n) => { const bg = color === STATE_META.queued.color ? '#6b7280' : color; return h('div', { style: { display: 'flex', flexDirection: 'column', flex: '0 0 auto' } }, h('div', { style: { height: 3, background: bg, borderRadius: '8px 8px 0 0' } }), h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '7px 9px', borderBottom: '1px solid rgba(127,127,127,.18)' } }, h('span', { style: { background: bg, color: '#fff', fontSize: 11.5, lineHeight: '18px', padding: '0 8px', borderRadius: 4, whiteSpace: 'nowrap', letterSpacing: '.02em' } }, label), h('span', { className: 'sa-hint', style: { marginLeft: 'auto' } }, String(n)))) }
      const doneList = viewRows.filter((t) => t.state === 'done')
      const kanban = h('div', { style: { display: 'flex', gap: 10, flex: 1, minHeight: 0 } },
        // 左侧：完成（整列，竖向滚轮）
        h('div', { style: { flex: '0 0 300px', display: 'flex', flexDirection: 'column', border: '1px solid rgba(127,127,127,.25)', borderRadius: 8, background: 'rgba(127,127,127,.04)', minHeight: 0 } },
          colHead('完成', STATE_META.done.color, doneList.length),
          h('div', { style: { flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: 7, display: 'flex', flexDirection: 'column', gap: 7, minHeight: 0 } },
            doneList.length === 0 ? h('div', { className: 'sa-hint', style: { padding: '6px 2px' } }, '空') : doneList.slice(0, 100).map((t) => kcard(t)),
          ),
        ),
        // 右侧：2×2（每格横向滚轮）；panel37：点卡片后右侧弹证据/参与人，只压缩这块，不动左侧「完成」列
        h('div', { style: { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', gap: 10, alignItems: 'stretch' } },
        h('div', { style: { flex: '1 1 0', display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', gap: 10, minWidth: 320, minHeight: 0 } },
          KANBAN_COLS.map((pair) => {
            const key = pair[0]
            const label = pair[1]
            const list = viewRows.filter((t) => t.state === key)
            const m = STATE_META[key] || STATE_META.queued
            return h('div', { key, style: { display: 'flex', flexDirection: 'column', border: '1px solid rgba(127,127,127,.25)', borderRadius: 8, background: 'rgba(127,127,127,.04)', minWidth: 0, minHeight: 0 } },
              colHead(label, m.color, list.length),
              h('div', { style: { flex: 1, display: 'flex', gap: 7, padding: 7, overflowX: 'auto', overflowY: 'hidden', alignItems: 'flex-start', minHeight: 0 } },
                list.length === 0
                  ? h('div', { className: 'sa-hint', style: { padding: '6px 2px' } }, '空')
                  : list.slice(0, 80).map((t) => kcard(t, 200)),
              ),
            )
          }),
        ),
                sel ? h('div', { style: { flex: '0 1 360px', width: 360, minWidth: 280, maxWidth: 360, display: 'flex' } }, h(Preview, { ticket: sel, onReveal, onClose: () => setSelId(null), tick: previewTick })) : null,
        ),
      )

      const hotBadge = () => h('span', { className: 'sa-hint', title: '保存即生效：内核/面板按 mtime 读取 settings.json，不用重启', style: { marginLeft: 2, padding: '0 5px', border: '1px solid rgba(34,197,94,.5)', color: '#16a34a', borderRadius: 4, fontSize: 11 } }, '热生效')
      const field = (label, key, suffix, hint) => h('label', { key, style: { display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 8px', flexWrap: 'wrap' } },
        h('span', { style: { width: 150, opacity: 0.75 } }, label),
        h('input', {
          value: stDraft[key] == null ? '' : stDraft[key],
          onChange: (ev) => setStDraft((d) => ({ ...d, [key]: ev.target.value })),
          inputMode: 'numeric',
          style: { width: 90, fontSize: 12.5, padding: '3px 7px', borderRadius: 5, border: '1px solid rgba(127,127,127,.35)', background: 'transparent', color: 'inherit' },
        }),
        suffix ? h('span', { className: 'sa-hint' }, suffix) : null,
        hint ? h('span', { className: 'sa-hint', style: { marginLeft: 4 } }, hint) : null,
        hotBadge(),
      )
      const toggle = (label, key, note) => h('label', { key, style: { display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 8px', cursor: 'pointer', flexWrap: 'wrap' } },
        h('span', { style: { width: 150, opacity: 0.75 } }, label),
        h('input', { type: 'checkbox', checked: !!stDraft[key], onChange: (ev) => setStDraft((d) => ({ ...d, [key]: ev.target.checked })) }),
        note ? h('span', { className: 'sa-hint' }, note) : null,
        hotBadge(),
      )
      const pickFrom = (label, key, options, hint) => h('label', { key, style: { display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 8px', flexWrap: 'wrap' } },
        h('span', { style: { width: 150, opacity: 0.75 } }, label),
        h('select', {
          value: stDraft[key] == null ? options[0].value : stDraft[key],
          onChange: (ev) => setStDraft((d) => ({ ...d, [key]: ev.target.value })),
          style: { fontSize: 12.5, padding: '3px 6px', borderRadius: 5, border: '1px solid rgba(127,127,127,.35)', background: 'transparent', color: 'inherit' },
        }, options.map((o) => h('option', { key: o.value, value: o.value }, o.label))),
        hint ? h('span', { className: 'sa-hint' }, hint) : null,
        hotBadge(),
      )
      const area = (label, key, hint) => h('label', { key, style: { display: 'flex', gap: 8, margin: '0 0 8px', alignItems: 'flex-start' } },
        h('span', { style: { width: 150, opacity: 0.75, paddingTop: 3 } }, label),
        h('textarea', {
          value: stDraft[key] == null ? '' : stDraft[key],
          onChange: (ev) => setStDraft((d) => ({ ...d, [key]: ev.target.value })),
          rows: 3,
          style: { flex: 1, minWidth: 220, fontSize: 12, padding: '4px 7px', borderRadius: 5, border: '1px solid rgba(127,127,127,.35)', background: 'transparent', color: 'inherit', fontFamily: 'inherit' },
        }),
        hint ? h('span', { className: 'sa-hint' }, hint) : null,
        hotBadge(),
      )
      const sect = (title, note, children) => h('details', { open: true, style: { border: '1px solid rgba(127,127,127,.22)', borderRadius: 8, padding: '8px 12px', margin: '0 0 10px', background: 'rgba(127,127,127,.04)' } },
        h('summary', { style: { cursor: 'pointer', fontWeight: 600, marginBottom: 8 } }, title, note ? h('span', { className: 'sa-hint', style: { marginLeft: 8, fontWeight: 400 } }, note) : null),
        children,
      )
      const diagTone = (st) => st === 'bad' ? '#dc2626' : st === 'missing' ? '#d97706' : st === 'ok' ? '#16a34a' : '#6b7280'
      const diagView = diag
        ? h('div', null,
          h('div', { style: { marginBottom: 6, fontSize: 12.5 } },
            '体检结果 ',
            h('span', { style: { color: '#16a34a' } }, 'ok ' + diag.summary.ok),
            h('span', { style: { margin: '0 6px', opacity: .4 } }, '/'),
            h('span', { style: { color: '#d97706' } }, 'missing ' + diag.summary.missing),
            h('span', { style: { margin: '0 6px', opacity: .4 } }, '/'),
            h('span', { style: { color: '#dc2626' } }, 'bad ' + diag.summary.bad),
            diag.summary.unverified ? h('span', { className: 'sa-hint', style: { marginLeft: 8 } }, 'unverified ' + diag.summary.unverified) : null,
            h('span', { className: 'sa-hint', style: { marginLeft: 8 } }, '· 只读，不会自动修'),
          ),
          ...(diag.checks || []).map((c) => h('div', { key: 'd' + c.key, style: { display: 'flex', gap: 8, padding: '4px 0', borderTop: '1px solid rgba(127,127,127,.12)', alignItems: 'baseline' } },
            h('span', { style: { width: 46, flex: '0 0 auto', color: diagTone(c.status), fontWeight: 600 } }, c.status),
            h('span', { style: { width: 210, flex: '0 0 auto', opacity: .85 } }, c.title),
            h('span', { style: { flex: 1, minWidth: 0, wordBreak: 'break-all', opacity: .8 } }, c.detail || ''),
            c.fix ? h('span', { className: 'sa-hint', style: { flex: '0 0 44%', minWidth: 200 } }, 'fix: ' + c.fix) : null,
          )),
        )
        : h('div', { className: 'sa-hint' }, '点「一键体检」扫描依赖与配套（只读）')
      const ownersView = ownersDoc
        ? h('div', null,
          ['owners', 'workers', 'judges', 'ops'].map((k) => h('div', { key: 'o' + k, style: { marginBottom: 6 } },
            h('span', { style: { display: 'inline-block', width: 70, opacity: .7 } }, k),
            (Array.isArray(ownersDoc[k]) && ownersDoc[k].length)
              ? ownersDoc[k].map((sid) => h('code', { key: k + sid, style: { marginRight: 8, fontSize: 11.5 } }, String(sid).replace(/^session-/, '').slice(0, 10) + '…'))
              : h('span', { className: 'sa-hint' }, '（空）'),
          )),
          h('div', { className: 'sa-hint', style: { marginTop: 4 } }, 'saRunAllow：' + (ownersDoc.saRunAllow === undefined ? '未设置 = 不限制模型' : '白名单 ' + JSON.stringify(ownersDoc.saRunAllow)) + ' · v1 只读，改角色请走 sa_role / 直接编辑 owners.json'),
        )
        : h('div', { className: 'sa-hint' }, '读角色中…')
      const fileVsEff = () => {
        const file = (stDoc && stDoc.settings) || {}
        const eff = (stDoc && stDoc.effective) || {}
        const keys = ['autoJudge', 'judgeRotate', 'notifyReadyTo', 'quietSources', 'deliverOut', 'docJudge', 'docCriteria', 'refreshMs', 'defaultTab', 'theme', 'watchdogAlerts', 'autoDispatch', 'runningTimeoutMs', 'ctxMonitor']
        return h('div', { style: { maxHeight: 220, overflow: 'auto', border: '1px solid rgba(127,127,127,.18)', borderRadius: 6 } },
          h('div', { style: { display: 'flex', gap: 8, padding: '4px 8px', fontWeight: 600, fontSize: 12 } }, h('span', { style: { flex: '0 0 180px' } }, '键'), h('span', { style: { flex: 1 } }, '文件值'), h('span', { style: { flex: 1 } }, '生效值')),
          keys.map((k) => h('div', { key: 'fe' + k, style: { display: 'flex', gap: 8, padding: '3px 8px', borderTop: '1px solid rgba(127,127,127,.1)', fontSize: 11.5 } },
            h('span', { style: { flex: '0 0 180px', opacity: .8 } }, k),
            h('span', { style: { flex: 1, wordBreak: 'break-all', color: file[k] === undefined ? '#9ca3af' : 'inherit' } }, file[k] === undefined ? '（未写，取默认）' : JSON.stringify(file[k]).slice(0, 160)),
            h('span', { style: { flex: 1, wordBreak: 'break-all' } }, JSON.stringify(eff[k] === undefined ? null : eff[k]).slice(0, 160)),
          )),
        )
      }
      const monitorBtns = h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '4px 0 6px' } },
        h('button', { className: 'sa-btn', onClick: () => void onMonitor('start') }, '启动监测'),
        h('button', { className: 'sa-btn', onClick: () => void onMonitor('stop') }, '停止监测'),
        h('button', { className: 'sa-btn', onClick: () => void onMonitor('restart') }, '重启监测'),
        monitorMsg ? h('span', { className: 'sa-hint' }, monitorMsg) : null,
      )
      const settingsView = stDoc
        ? h('div', { style: { maxWidth: 860, width: '100%' } },
          h('div', { className: 'sa-hint', style: { marginBottom: 8 } }, '写入 ' + stDoc.file + ' · 所有项保存即热生效（内核/面板按 mtime 读取）；下面同时列出「文件值 / 生效值」'),
          sect('A. 一键适配体检', '只读 · 不自动修复', h('div', null,
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 } },
              h('button', { className: 'sa-btn', onClick: () => void runDiag(), disabled: diagBusy }, diagBusy ? '体检中…' : '一键体检'),
              h('span', { className: 'sa-hint' }, '12 项：宿主/插件/服务/owner/state/归档/免费模型/QQ/Codex/watcher/监测'),
            ),
            diagView,
          )),
          sect('B. 流程开关', '关掉会怎样写在每行后面', h('div', null,
            field('运行超时', 'timeoutMin', '分钟', '超过该时长无进展 → 判 blocked'),
            field('投递重试上限', 'deliver', '次', '投递失败超过该次数 → 放弃并记 abandoned'),
            field('附件体积上限', 'capMb', 'MB', 'sa_attach / 回传共用的上限'),
            toggle('定时看门狗', 'watchdog', '关闭后不再自动巡检（sa_watchdog 仍可手动）'),
            toggle('自动派单', 'autoDispatch', '关闭后 queued 单不会自动派给 workers'),
            field('自动派单间隔', 'autoMs', 'ms', '默认 15000'),
            toggle('错误证据', 'evidence', '关闭后失败单不再自动写 error-evidence.md'),
            field('autoJudge（judge 会话 id / true / false）', 'autoJudge', '', 'false = 关闭（回退提醒 owner）；true = 取 judges[0]'),
            toggle('judge 轮换', 'judgeRotate', 'autoJudge=true 时在 judges 里轮换'),
            pickFrom('ready 提醒对象', 'notifyReadyTo', [{ value: 'judge', label: 'judge（默认）' }, { value: 'owner', label: 'owner' }], 'verdict 后固定提醒 owner'),
            field('quietSources（逗号分隔）', 'quietSources', '', '如 qq,http,cron：这些来源建单不提醒 owner'),
            pickFrom('完成回传', 'deliverOutMode', [{ value: 'off', label: '关（默认）' }, { value: 'onebot', label: 'OneBot 上传' }], '关 = sa_sendback 报「deliverOut 未配置」'),
            field('回传 apiBase', 'deliverOutApi', '', '仅 OneBot：本机 http(s) 地址，如 http://127.0.0.1:3001'),
            toggle('文档轻判据', 'docJudge', 'type=doc 的单用 4 条轻判据（仍走 judge）'),
            area('doc 判据（每行一条，空=内置 4 条）', 'docCriteria'),
          )),
          sect('C. 角色与模型', 'v1 只读，不写 owners.json', ownersView),
          sect('D. 通知', '勾选哪些事件提醒 owner', h('div', null,
            toggle('judge 判不通过', 'neVerdictFail', 'verdict fail → 提醒 owner 回修'),
            toggle('看门狗告警', 'neWatchdog', '仅在 watchdogAlerts 开启时生效'),
            toggle('投递失败', 'neDeliverFailed', 'outbox 放弃时提醒'),
            toggle('文档完成', 'neDocDone', 'type=doc 的单 done 时提醒'),
            h('div', { className: 'sa-hint' }, '提醒目标由宿主 bindings 决定（本会话 / QQ），v1 只显示不改'),
          )),
          sect('E. 数据与归档', 'pruneCaps 可视化 + 导出', h('div', null,
            field('outbox 上限', 'outboxMax', '条'),
            field('outbox 保留', 'outboxDays', '天'),
            field('放弃条目保留', 'abandonedDays', '天'),
            field('history 上限', 'historyMax', '条'),
            field('artifacts 上限', 'artifactMax', '条'),
            field('reports 上限', 'reportMax', '条'),
            h('div', { style: { marginTop: 6 } },
              h('button', { className: 'sa-btn', onClick: () => { try { void navigator.clipboard.writeText(JSON.stringify(stDoc.effective || {}, null, 1)); flash('已复制当前「生效配置」JSON') } catch (e) { flash('复制失败，请手动选中文本') } } }, '导出当前生效配置 JSON'),
            ),
          )),
          sect('F. 面板自身', '', h('div', null,
            field('刷新间隔', 'refreshMs', 'ms', '默认 1500'),
            pickFrom('默认页签', 'defaultTab', [{ value: 'tickets', label: '工单' }, { value: 'archive', label: '归档' }, { value: 'stats', label: '统计' }, { value: 'settings', label: '设置' }]),
            pickFrom('主题', 'theme', [{ value: 'auto', label: 'auto' }, { value: 'light', label: 'light' }, { value: 'dark', label: 'dark' }]),
          )),
          sect('G. 上下文监测（默认关）', '参数热生效：监测进程每轮读 settings.json；启停才动进程', h('div', null,
            h('div', { className: 'sa-hint', style: { marginBottom: 6 } }, '徽标都是「热生效」：改阈值后监测进程在本轮/下一轮判定时就用新值（不用重启监测）。启停/重启按钮只控制进程本身。'),
            monitorBtns,
            field('轮询间隔', 'cmInterval', '秒', '默认 60（10~3600）'),
            field('官方 DS 阈值', 'cmOfficial', '%', 'provider=deepseek-account 用'),
            field('其它 provider 阈值', 'cmOther', '%', '未命中覆盖表时用'),
            area('按 provider 覆盖（每行 provider=pct，如 trae=80）', 'cmThresholds'),
            toggle('越线写 ingress 建单', 'cmAlertIngress', '关闭后只写本地告警日志，不建单'),
          )),
          sect('文件值 vs 生效值', '文件值 = settings.json 原样；生效值 = 深合并默认值后的实际结果', fileVsEff()),
          h('div', { style: { marginTop: 10, display: 'flex', gap: 8 } },
            h('button', { className: 'sa-btn', onClick: () => void saveSettings() }, '保存'),
            h('button', { className: 'sa-btn', onClick: () => setStDraft(toDraft(stDoc.defaults)) }, '恢复默认值'),
            h('button', { className: 'sa-btn', onClick: () => void loadSettings() }, '重新读取'),
            h('button', { className: 'sa-btn', onClick: () => void runDiag() }, '重新体检'),
          ),
        )
        : h('div', { className: 'sa-empty' }, '读设置中…')

      return h('div', { className: 'sa-page', style: { height: 'calc(100vh - 96px)', display: 'flex', flexDirection: 'column', boxSizing: 'border-box', overflow: 'hidden' } },
        h('div', { className: 'sa-hero' },
          h('div', { className: 'sa-hero-bg', style: { backgroundImage: 'url(' + BANNER + ')' } }),
          h('div', { className: 'sa-head' },
            h('h2', { className: 'sa-title' }, '工单队列'),
            stateChips,
            h('span', { className: 'sa-hint', style: { marginLeft: 'auto' } }, '更新于 ' + new Date(data.generatedAt || Date.now()).toLocaleTimeString() + ' · 只读'),
          ),
          h('div', { className: 'sa-sub' }, '数据源 handoff/superagent/state.json。只提供「结档」一个写操作（走 commands 队列），其余改动请在对话里用工具。'),
        ),
        h('div', { className: 'sa-tabs', style: { display: 'flex', gap: 6, margin: '2px 0 10px' } },
          tabBtn('tickets', '工单 ' + rows.length),
          tabBtn('archive', '归档' + (archTotal ? ' ' + archTotal : '')),
          tabBtn('stats', '统计'),
          tabBtn('settings', '设置'),
        ),
        toast ? h('div', { className: 'sa-toast' }, toast) : null,
        tab === 'archive'
          ? h('div', { style: { flex: 1, minHeight: 0, display: 'flex', gap: 12, alignItems: 'flex-start' } },
            h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' } },
              h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' } },
                h('input', {
                  value: archQ,
                  placeholder: '搜归档：编号 / 标题 / 类型（测试·代码·办公）',
                  onChange: (ev) => setArchQ(ev.target.value),
                  onKeyDown: (ev) => { if (ev.key === 'Enter') void onArchive() },
                  style: { width: 240, fontSize: 12.5, padding: '4px 8px', borderRadius: 5, border: '1px solid rgba(127,127,127,.35)', background: 'transparent', color: 'inherit' },
                }),
                h('button', { className: 'sa-btn', onClick: () => void onArchive() }, '查询'),
                h('button', { className: 'sa-btn', title: '进入批量：勾几张一起回滚', onClick: () => { setAbatchOn((v) => !v); setAselIds([]) }, style: abatchOn ? { borderColor: 'rgba(245,158,11,.75)', background: 'rgba(245,158,11,.14)' } : undefined }, abatchOn ? '退出批量' : '批量'),
                abatchOn ? h('span', { className: 'sa-hint' }, '已选 ' + aselIds.length) : null,
                abatchOn ? h('button', { className: 'sa-btn', onClick: () => void onBatchRestore(), style: { background: '#5c4033', color: '#fff', border: 'none', borderRadius: 4, fontWeight: 400 } }, '批量回滚') : null,
                abatchOn ? h('button', { className: 'sa-btn', onClick: () => setAselIds([]) }, '清空') : null,
                h('button', {
                  className: 'sa-btn',
                  onClick: () => void onRollbackAll(),
                  style: rbArmed ? { borderColor: 'rgba(239,68,68,.8)', background: 'rgba(239,68,68,.16)' } : undefined,
                }, rbArmed ? '再点一次确认回滚全部' : '回滚全部'),
                h('span', { className: 'sa-hint', style: { marginLeft: 'auto' } }, '证据在 archive/evidence/<工单>/；点 Fact-<工单号>-<序号> 看正文'),
              ),
              archRows === null
                ? h('div', { className: 'sa-empty' }, '正在读归档…')
                : archRows.length === 0
                  ? h('div', { className: 'sa-empty' }, archQ ? '没命中「' + archQ + '」' : '归档为空（回滚全部之后归档目录会被搬空）')
                  : h('div', { className: 'sa-table-wrap', style: { maxHeight: 'calc(100vh - 250px)', overflow: 'auto' } },
                    archHasMore ? h('div', { className: 'sa-muted', style: { margin: '2px 0 6px' } }, '仅显示前 200 条，共 ' + archTotal + ' 条（用搜索缩小范围）') : null,
                    h('div', { className: 'sa-hint', style: { margin: '2px 0 6px' } }, '归档结果 ' + archTotal + ' 条 · 回滚只写 commands 队列，由 lite 按状态机搬回 state'),
                    h('table', { className: 'sa-table', style: { fontSize: 12.5 } },
                      h('thead', null, h('tr', null, abatchOn ? h('th', { style: { width: 24, padding: '8px 4px' } }, '') : null, h('th', null, '工单'), h('th', null, '状态'), h('th', null, '类型'), h('th', null, '归档于'), h('th', null, '证据'), h('th', null, '操作'), h('th', null, '标题'))),
                      h('tbody', null, ...archRows.reduce((acc, r) => {
                        acc.push(h('tr', { key: r.id },
                          abatchOn ? h('td', { style: { padding: '8px 4px' } }, h('input', { type: 'checkbox', checked: aselIds.includes(r.id), onChange: () => toggleASel(r.id) })) : null,
                          h('td', { className: 'sa-id' }, r.id),
                          h('td', { className: 'sa-muted' }, r.state),
                          h('td', null, typeCell({ type: r.type }, true)),  // panel31：没类型的也显示灰色「未标」标签，别只画个破折号
                          h('td', { className: 'sa-muted', title: r.archivedAt || '' }, r.archivedAt ? String(r.archivedAt).slice(0, 10) : '—'),
                          h('td', null,
                            h('button', { className: 'sa-btn', 'data-open': r.id, onClick: () => void onArchFiles(r.id) }, archEvId === r.id ? '收起' : '证据 ' + (r.artifacts || 0)),
                            h('button', { className: 'sa-btn', 'data-verdict': r.id, title: '看这张单的验收判词（archive/verdicts/<id>.md）', style: { marginLeft: 4 }, onClick: () => void onArchVerdict(r.id) }, '判词'),
                          ),
                          h('td', null,
                            h('button', { className: 'sa-btn', 'data-rollback': r.id, onClick: () => void onRollbackOne(r.id) }, '回滚'),
                          ),
                          h('td', { className: 'sa-title' }, r.title || ''),
                        ))
                        if (archEvId === r.id) {
                          const files = archFiles[r.id] || []
                          acc.push(h('tr', { key: r.id + '-ev' },
                            h('td', { colSpan: abatchOn ? 8 : 7, style: { background: 'rgba(127,127,127,.05)' } },
                              files.length === 0
                                ? h('span', { className: 'sa-hint' }, '这张归档单没有 evidence 文件（归档时只搬了工单记录）')
                                : h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', padding: '2px 0' } },
                                  ...files.map((f) => h('button', {
                                    key: f.fact,
                                    className: 'sa-btn',
                                    'data-fact': f.fact,
                                    title: f.name + ' · ' + f.bytes + 'B',
                                    style: (archDoc && archDoc.relative === 'archive/evidence/' + r.id + '/' + f.name) ? { borderColor: 'rgba(245,158,11,.75)', background: 'rgba(245,158,11,.14)' } : undefined,
                                    onClick: () => void onArchOpen(r.id, f.name),
                                  }, f.fact)),
                                ),
                            ),
                          ))
                        }
                        return acc
                      }, [])),
                    ),
                  ),
            ),
            h('div', { style: { width: 400, flex: '0 0 400px', border: '1px solid rgba(127,127,127,.28)', borderRadius: 8, overflow: 'hidden', display: 'flex', flexDirection: 'column', background: 'rgba(127,127,127,.04)', maxHeight: 'calc(100vh - 250px)' } },
              h('div', { className: 'sa-preview-head' },
                h('span', { style: { fontWeight: 600, flex: '0 0 auto' } }, archDoc ? String(archDoc.relative || '').split('/').pop() : '归档证据'),
                h('span', { className: 'sa-hint', style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, archDoc ? String(archDoc.relative || '') : ''),
                h('button', { className: 'sa-btn', onClick: () => setArchDoc(null) }, '清空'),
              ),
              archDoc
                ? h('div', { className: 'sa-preview-body' }, ...renderMarkdown(archDoc.text || ''))
                : h('div', { className: 'sa-empty', style: { padding: 18 } }, '点左侧 Fact-<工单号>-<序号> 查看归档证据正文'),
              archDoc && archDoc.truncated ? h('div', { className: 'sa-hint', style: { padding: '4px 10px', borderTop: '1px solid rgba(127,127,127,.2)' } }, '文件太大，只显示前 256 KB') : null,
            ),
          )
          : tab === 'stats'
            ? statsView
            : tab === 'settings'
              ? h('div', { style: { flex: 1, minHeight: 0, overflow: 'auto', paddingRight: 6 } }, settingsView)
            : h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '0 0 10px', flex: '0 0 auto' } },
                seg('table', '表格'), seg('kanban', '看板'),
                h('button', { className: 'sa-btn', title: '进入批量：表格与看板共用同一套勾选', onClick: () => { setBatchOn((v) => !v); setSelIds([]) }, style: batchOn ? { borderColor: 'rgba(245,158,11,.75)', background: 'rgba(245,158,11,.14)' } : undefined }, batchOn ? '退出批量' : '批量'),
                h('input', {
                  value: tq,
                  placeholder: '搜工单：编号 / 标题 / 类型',
                  onChange: (ev) => setTq(ev.target.value),
                  style: { width: 200, fontSize: 12, padding: '3px 8px', borderRadius: 5, border: '1px solid rgba(127,127,127,.35)', background: 'transparent', color: 'inherit' },
                }),
                picker(fType, [{ value: 'all', label: '类型：全部' }, { value: 'test', label: '测试' }, { value: 'code', label: '代码' }, { value: 'office', label: '办公' }], setFType, '按工单类型筛选'),
                picker(fBackend, [{ value: 'all', label: '后端：全部' }].concat(backends.map((b) => ({ value: b, label: b === 'none' ? '无后端' : b }))), setFBackend, '按后端筛选'),
                picker(fRange, [{ value: 'all', label: '号段：全部' }].concat(ranges.map((r) => ({ value: r, label: r }))), setFRange, '按编号区间筛选'),
                h('span', { className: 'sa-hint' }, '命中 ' + viewRows.length + ' / ' + rows.length),
                batchOn ? h('span', { className: 'sa-hint' }, '已选 ' + selIds.length) : null,
                batchOn ? h('button', { className: 'sa-btn', onClick: () => void onBatchArchive(), style: { background: '#5c4033', color: '#fff', border: 'none', borderRadius: 4, fontWeight: 400 } }, '批量归档') : null,
                batchOn ? h('button', { className: 'sa-btn', onClick: () => setSelIds([]) }, '清空') : null,
              ),
              view === 'kanban' ? kanban : (viewRows.length === 0 ? h('div', { className: 'sa-empty' }, '当前筛选没有命中工单。') : table),
            ),
      )
    }

    function DockPanel(props) {
      useStyleOnce()
      const { data, dead } = useTickets()
      const [ownerIds, setOwnerIds] = useState(null)
  // 2026-11-07：dock 默认收起。有活跃单时它挂在输入框上方，展开状态会挤到宿主提示区。
  const [dockOpen, setDockOpen] = useState(false)
      useEffect(() => {
        let alive = true
        const pull = async () => {
          try {
            const res = await fetch('/superagent/owners', { headers: { accept: 'application/json' } })
            const body = await res.json().catch(() => ({}))
            if (alive) setOwnerIds(Array.isArray(body.owners) ? body.owners.map(String) : [])
          } catch { if (alive) setOwnerIds([]) }
        }
        void pull()
        const timer = setInterval(() => { void pull() }, 30000)
        return () => { alive = false; clearInterval(timer) }
      }, [])
      // panel28：只在「决策人」会话显示。三态：
      //   ① 拿到 sessionId + owners 名单非空 → 严格比对（非决策人 = 不渲染）
      //   ② 宿主没 inject 到 sessionId（老宿主/注册被拒）→ 保持旧行为（显示），不冒失藏起来
      //   ③ owners 还没拉到或为空 → 先按显示处理
      const sid = props && props.sessionId ? String(props.sessionId) : ''
      const owners = Array.isArray(ownerIds) ? ownerIds : null
      const decided = !!sid && owners !== null && owners.length > 0
      const isOwner = !decided || owners.includes(sid)
      if (!isOwner) return null
      if (dead || !data) return null
      const active = Number(data.active || 0)
      if (!active) return null
      const rows = (data.tickets || []).filter((t) => t.state !== 'done')
  const shownRows = dockOpen ? rows.slice(0, 4) : []
      const counts = data.counts || {}
      const order = ['running', 'ready', 'queued', 'blocked']
      return h('div', { 'data-superagent-panel': 'dock', style: { display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 10px', margin: '4px 0 0 0', border: '1px solid rgba(127,127,127,.28)', borderRadius: 8, fontSize: 12, lineHeight: 1.45, background: 'rgba(127,127,127,.06)' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { style: { fontWeight: 600, opacity: .9 } }, '工单'),
          h('span', { style: { opacity: .38, fontVariantNumeric: 'tabular-nums' }, title: sid || '宿主没把 sessionId 注进来' }, sid ? sid.replace(/^session-/, '').slice(0, 8) + ' · 决策人' : '会话未知'),
          h('span', { style: { opacity: .7 } }, order.filter((k) => counts[k]).map((k) => STATE_META[k].label + ' ' + counts[k]).join(' · ')),
          h('span', { style: { marginLeft: 'auto', opacity: .55, cursor: 'pointer' }, onClick: () => setDockOpen((v) => !v) }, dockOpen ? '收起' : rows.length + ' 条 · 展开'),
        h('span', { style: { opacity: .45, marginLeft: 10 } }, '看全部 → 左侧栏「工单」'),
        ),
        ...shownRows.map((t) => {
          const m = STATE_META[t.state] || STATE_META.queued
          return h('div', { key: t.id, style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
            h('span', { style: { width: 6, height: 6, borderRadius: 3, background: m.color, display: 'inline-block', flex: '0 0 auto' } }),
            h('span', { style: { fontVariantNumeric: 'tabular-nums', opacity: .75, flex: '0 0 auto' } }, t.id),
            h('span', { style: { color: m.color, flex: '0 0 auto' } }, m.label),
            h('span', { style: { flex: '0 0 auto', opacity: .55 }, title: ageTitle(t.ageMin) }, (t.backend ? t.backend + ' · ' : '') + fmtAge(t.ageMin)),
            h('span', { style: { opacity: .8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, t.title || ''),
          )
        }),
      )
    }

    function apply(ctx) {
      const trySlot = (name, opts, Comp) => {
        try { ctx.slots.inject(name, () => ctx.slots.register({ name, ...opts }, Comp)) }
        catch (err) { try { console.warn('[superagent-panel37] slot unavailable:', name, err && err.message) } catch {} }
      }
      trySlot('sidebar.panellist', { id: PANEL_ID, order: 30, label: () => '工单' }, SidebarIcon)
      trySlot('main', { key: PANEL_ID }, MainPage)
      // panel28：宿主 slot 支持 inject(sessionId) → 组件 props 里拿到当前会话（照 conversation-queue-dock 的写法）
      const dockInject = (sessionId) => ({ sessionId: String(sessionId || '') })
      trySlot('conversation.input.dock', { id: 'superagent-panel-dock', order: 70, label: '工单看板', inject: dockInject }, DockPanel)
    }

    return { inject: ['slots', 'sessions'], apply }
  },
})
