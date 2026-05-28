// ===== Trie-based Offline Dictionary Engine (Webapp) =====
// Uses IndexedDB for imported dict persistence (no size limit)
// Uses localStorage for custom phrases only (small)
(function () {
    function isCJK(ch) {
        var code = ch.charCodeAt(0);
        return (code >= 0x4e00 && code <= 0x9fff) ||
            (code >= 0x3400 && code <= 0x4dbf) ||
            (code >= 0xf900 && code <= 0xfaff);
    }

    var root = null;
    var ready = false;
    var phienamMap = new Map();
    var customEntries = new Map();
    var cachedTSV = '';
    var baseTSV = '';
    var entryCount = 0;
    var loadedUrl = 'dict-default.json';
    var DB_NAME = 'cnvn-dict';
    var DB_VERSION = 1;
    var QUALITY_OVERRIDES_URL = 'dicts/QualityOverrides.txt';
    var qualityOverrideTSV = '';

    // Traditional → Simplified conversion
    var tradSimpMap = null;
    var chuyenGianThe = localStorage.getItem('vp_chuyen_gian_the') !== '0';

    // ThuatToanNhan: constrain LuatNhan {0} captures
    // 0=off, 1=pronouns only, 2=pronouns+names(pri>=20), 3=pronouns+names+vietphrase(pri>=10)
    var thuatToanNhan = parseInt(localStorage.getItem('vp_thuat_toan_nhan'), 10);
    if (isNaN(thuatToanNhan) || thuatToanNhan < 0 || thuatToanNhan > 3) thuatToanNhan = 2;

    // Built-in pronouns (28 entries from QT's Pronouns.txt)
    var PRONOUNS_RAW = '你自己\t大家伙儿\t同学们\t大伙儿\t老师们\t自个儿\t他人\t他们\t你们\t别人\t同学\t咱们\t她们\t它们\t您们\t我们\t旁人\t老师\t自己\t诸位\t他\t你\t咱\t她\t它\t您\t我\t朕';
    var pronounSet = new Set(PRONOUNS_RAW.split('\t'));
    var pronounLikePossessorSet = new Set('大家\t众人\t眾人'.split('\t'));
    var SEARCH_BEAM_WIDTH = 24;
    var CAPTURE_BEAM_WIDTH = 10;
    var SEARCH_MAX_CANDIDATES = 12;
    var CAPTURE_MAX_CANDIDATES = 8;
    var SEARCH_MAX_STATES_PER_POS = 4;
    var MAX_STORED_ALT_VALUES = 4;
    var MAX_SIMPLE_MEANING_ALTS = 2;
    var NUMERIC_CAPTURE_RE = /^[0-9０-９一二三四五六七八九十百千万零两〇廿卅]+$/;
    var CHAPTER_PATTERN_RE = /^第[0-9０-９一二三四五六七八九十百千万零两〇廿卅]+章$/;
    var STANDALONE_LIEU_RE = /(^|[^A-Za-zÀ-ỹ])liễu(?=$|[^A-Za-zÀ-ỹ])/i;
    var STANDALONE_DICH_RE = /(^|[^A-Za-zÀ-ỹ])đích(?=$|[^A-Za-zÀ-ỹ])/i;
    var VI_PRONOUN_START_RE = /^(?:các ngươi|chúng ta|chúng tôi|bọn họ|bọn hắn|anh ấy|cô ấy|mọi người|ngươi|hắn|nàng|mình|ta|họ|y|gã|nó)(?:\s|$)/i;
    var VI_PRONOUN_END_RE = /(?:^|\s)(?:ta|ngươi|hắn|nàng|họ|mình|mọi người|y|gã|nó|chúng ta|chúng tôi|bọn họ|bọn hắn|anh ấy|cô ấy)\s*$/i;
    var VI_VERBISH_START_RE = /^(?:làm|đi|đến|đưa|nói|nhìn|ăn|uống|chạy|đánh|giết|mở|đóng|sắp xếp|bố trí|hoạt động|tác nghiệp|tu luyện|bơi|ngủ|gọi|rời|trở|cười|khóc|mang|cầm|giữ|chiếm)\b/i;
    var VI_NOUNISH_START_RE = /^(?:bài|người|công|sự|việc|trận|đạo|kiếm|đan|thân|tâm|đệ tử|giáo viên|bức|pho|quyển|chương|vòng|con|cây|gốc|cỏ|áo|bào|thuốc|nhà|cửa|môn|đường|thức|vật|lực|thuật|pháp)\b/i;
    var COMPLEMENT_VERB_SOURCE_RE = /^(?:活|死|编|編|按|送|累|拒绝|拒絕|跑|走|飞|飛|打|杀|殺|哭|笑|急|吓|嚇|长|長|穿|写|寫|说|說|问|問|看|听|聽|做|弄|想|修炼|修煉)$/;
    var DISPOSAL_VERB_SOURCE_RE = /^(?:送|扔|丢|丟|交|还|還|带|帶|拿|取|放|拉|推|打|揍|收|搬|移|藏|塞|杀|殺|救|关|關|开|開|送来|送來|送走|送去|送回|扔给|扔給|丢给|丟給|交给|交給|还给|還給|带来|帶來|带走|帶走|带回|帶回|拿来|拿來|拿走|拿回|拿出|取出|放回|放进|放進|放入|放下|放走|放跑|拉回|拉走|推开|推開|推走|打开|打開|关上|關上|收起|收走|收回|搬走|搬来|搬來|移开|移開|移走)$/;
    var PASSIVE_ZHE_SKIP_SOURCE_RE = /^(?:告|子|窝|窩|褥|单|單|动|動)$/;
    var VI_UPPER_START_RE = /^[A-ZÀÁẠẢÃĂẮẰẶẲẴÂẤẦẬẨẪĐÈÉẸẺẼÊẾỀỆỂỄÌÍỊỈĨÒÓỌỎÕÔỐỒỘỔỖƠỚỜỢỞỠÙÚỤỦŨƯỨỪỰỬỮỲÝỴỶỸ]/;
    var VI_ALL_CAPS_TOKEN_RE = /^[A-ZÀÁẠẢÃĂẮẰẶẲẴÂẤẦẬẨẪĐÈÉẸẺẼÊẾỀỆỂỄÌÍỊỈĨÒÓỌỎÕÔỐỒỘỔỖƠỚỜỢỞỠÙÚỤỦŨƯỨỪỰỬỮỲÝỴỶỸ]+$/;
    var RUNTIME_DOUBLE_SURNAME_VI = {
        '司马': 'Tư Mã', '司馬': 'Tư Mã', '慕容': 'Mộ Dung', '欧阳': 'Âu Dương', '歐陽': 'Âu Dương',
        '上官': 'Thượng Quan', '诸葛': 'Gia Cát', '諸葛': 'Gia Cát', '公孙': 'Công Tôn', '公孫': 'Công Tôn',
        '夏侯': 'Hạ Hầu', '西门': 'Tây Môn', '西門': 'Tây Môn', '东方': 'Đông Phương', '東方': 'Đông Phương',
        '南宫': 'Nam Cung', '南宮': 'Nam Cung', '令狐': 'Lệnh Hồ', '皇甫': 'Hoàng Phủ', '尉迟': 'Uất Trì',
        '尉遲': 'Uất Trì', '长孙': 'Trưởng Tôn', '長孫': 'Trưởng Tôn', '宇文': 'Vũ Văn', '端木': 'Đoan Mộc',
        '司徒': 'Tư Đồ', '司空': 'Tư Không', '申屠': 'Thân Đồ', '闻人': 'Văn Nhân', '聞人': 'Văn Nhân',
        '轩辕': 'Hiên Viên', '軒轅': 'Hiên Viên', '呼延': 'Hô Diên', '赫连': 'Hách Liên', '赫連': 'Hách Liên',
        '澹台': 'Đạm Đài', '公羊': 'Công Dương', '拓跋': 'Thác Bạt', '百里': 'Bách Lý', '东郭': 'Đông Quách',
        '東郭': 'Đông Quách', '钟离': 'Chung Ly', '鍾離': 'Chung Ly', '太史': 'Thái Sử', '仲孙': 'Trọng Tôn',
        '仲孫': 'Trọng Tôn', '颛孙': 'Chuyên Tôn', '顓孫': 'Chuyên Tôn', '亓官': 'Kỳ Quan', '宰父': 'Tể Phụ',
        '谷梁': 'Cốc Lương', '穀梁': 'Cốc Lương', '段干': 'Đoạn Can', '微生': 'Vi Sinh', '羊舌': 'Dương Thiệt',
        '梁丘': 'Lương Khâu', '左丘': 'Tả Khâu', '东门': 'Đông Môn', '東門': 'Đông Môn'
    };
    function makeCharLookup(chars) {
        var out = Object.create(null);
        for (var i = 0; i < chars.length; i++) out[chars[i]] = true;
        return out;
    }
    var RUNTIME_CONTEXT_SINGLE_SURNAME_LOOKUP = makeCharLookup(
        '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田胡凌霍虞万支柯管卢莫房裘解应宗丁宣邓郁杭洪包诸左石崔吉龚程邢裴陆荣翁荀羊惠甄家封芮羿储靳松井段富巫乌焦巴牧山谷车侯全班仰秋仲伊宫宁仇甘厉祖武符刘景詹束龙叶幸韶黎白蒲索赖卓屠蒙池乔辛简饶曾沙养丰关相查荆红游竺权盖益桓庾终衡步都耿满弘匡国文寇广禄沃利蔚越师聂冷那柴牛蛮象'
    );
    var RUNTIME_NAME_STOP_CHARS = '的一了着著过過地得在到从從和与與也都就只乃是有无無不没沒把被将將给給为為之其这這那哪何谁誰吗嗎呢吧啊嘛呗唄';
    var RUNTIME_NAME_BAD_GIVEN_CHARS = '说說问問道笑喊叫答骂罵叹嘆看听聽想见見来來去回起又再手人者头頭事物门門法力气氣心中上下内內外前后後里裡哥姐弟妹爷爺娘叔伯嫂师師';
    var RUNTIME_NAME_BAD_GIVEN_WORDS = {
        '玩乐': true, '玩樂': true, '想见': true, '想見': true, '豫章': true, '别说': true, '別說': true,
        '承担': true, '承擔': true, '军士': true, '軍士': true, '出去': true, '禁报': true, '禁報': true,
        '法力': true, '先生': true, '老师': true, '老師': true, '师兄': true, '師兄': true, '师姐': true,
        '師姐': true, '师弟': true, '師弟': true, '师妹': true, '師妹': true, '继续': true, '繼續': true,
        '解释': true, '解釋': true, '随意': true, '隨意': true, '赞赏': true, '贊賞': true,
        '知道': true, '知晓': true, '知曉': true, '再次': true, '工作': true, '临时': true, '臨時': true
    };
    var RUNTIME_NAME_RIGHT_CONTEXT_CUES = [
        '淡淡道', '平静道', '平靜道', '解释道', '解釋道', '冷冷道', '沉声道', '沉聲道', '笑着道', '笑著道',
        '思索道', '保证道', '保證道', '淡笑道', '又怒道', '急道', '怒道', '忙道',
        '说道', '說道', '问道', '問道', '笑道', '喊道', '叫道', '答道', '骂道', '罵道', '叹道', '嘆道',
        '低声道', '低聲道', '说道：', '說道：', '问道：', '問道：'
    ];
    var RUNTIME_NAME_LEFT_CONTEXT_CUES = [
        '名叫', '叫做', '叫作', '名为', '名為', '号称', '號稱', '称为', '稱為', '唤作', '喚作'
    ];
    var KINSHIP_ALIAS_SUFFIX_TRANSLATIONS = [
        ['师叔祖', 'sư thúc tổ'], ['師叔祖', 'sư thúc tổ'],
        ['师叔母', 'sư thúc mẫu'], ['師叔母', 'sư thúc mẫu'],
        ['师叔', 'sư thúc'], ['師叔', 'sư thúc'],
        ['师兄', 'sư huynh'], ['師兄', 'sư huynh'],
        ['师姐', 'sư tỷ'], ['師姐', 'sư tỷ'],
        ['师弟', 'sư đệ'], ['師弟', 'sư đệ'],
        ['师妹', 'sư muội'], ['師妹', 'sư muội'],
        ['表哥', 'biểu ca'], ['表姐', 'biểu tỷ'],
        ['表弟', 'biểu đệ'], ['表妹', 'biểu muội'],
        ['堂哥', 'đường ca'], ['堂姐', 'đường tỷ'],
        ['堂弟', 'đường đệ'], ['堂妹', 'đường muội'],
        ['哥哥', 'ca ca'], ['姐姐', 'tỷ tỷ'],
        ['弟弟', 'đệ đệ'], ['妹妹', 'muội muội'],
        ['小姐', 'tiểu thư'], ['公子', 'công tử'], ['姑娘', 'cô nương'],
        ['先生', 'tiên sinh'], ['夫人', 'phu nhân'],
        ['老头', 'lão đầu'], ['老頭', 'lão đầu'], ['某', 'mỗ'],
        ['叔', 'thúc'], ['哥', 'ca'], ['姐', 'tỷ'],
        ['爷', 'gia'], ['爺', 'gia'], ['娘', 'nương'],
        ['伯', 'bá'], ['嫂', 'tẩu']
    ];
    var KINSHIP_ALIAS_PREFIX_STOP_RE = /[你我他她它咱您们們的了地得着著过過去来來找喊叫问問说說道看给給把被将將是有在不没沒会會能要让讓请請小老大姑奶爷爺娘叔伯嫂哥姐弟妹师師]/;

    // LuatNhan pattern matching state
    var patPrefixRoot = null;  // Trie of pattern prefixes → leaf.patterns = [{suffix, template}]
    var patSuffixRoot = null;  // Trie of suffixes for {0}-starting patterns → leaf.templates = [template]
    var hasPatterns = false;

    function createNode() { return { c: Object.create(null), v: null, p: 0, s: '', k: '', o: -1, a: null }; }

    function compareNodeEntries(a, b) {
        if ((b.p | 0) !== (a.p | 0)) return (b.p | 0) - (a.p | 0);
        return (b.o | 0) - (a.o | 0);
    }

    function setNodeWinner(node, rec) {
        node.v = rec.v;
        node.p = rec.p | 0;
        node.s = rec.s || '';
        node.k = rec.k || '';
        node.o = rec.o | 0;
    }

    function upsertNodeAlt(node, rec) {
        if (!node.a) node.a = [];
        for (var i = 0; i < node.a.length; i++) {
            if (node.a[i].v !== rec.v) continue;
            if ((rec.p | 0) > (node.a[i].p | 0) || (((rec.p | 0) === (node.a[i].p | 0)) && ((rec.o | 0) >= (node.a[i].o | 0)))) {
                node.a[i] = { v: rec.v, p: rec.p | 0, s: rec.s || '', k: rec.k || '', o: rec.o | 0 };
            }
            node.a.sort(compareNodeEntries);
            if (node.a.length > MAX_STORED_ALT_VALUES) node.a.length = MAX_STORED_ALT_VALUES;
            return;
        }
        node.a.push({ v: rec.v, p: rec.p | 0, s: rec.s || '', k: rec.k || '', o: rec.o | 0 });
        node.a.sort(compareNodeEntries);
        if (node.a.length > MAX_STORED_ALT_VALUES) node.a.length = MAX_STORED_ALT_VALUES;
    }

    function removeNodeAltValue(node, value) {
        if (!node.a) return;
        for (var i = node.a.length - 1; i >= 0; i--) {
            if (node.a[i].v === value) node.a.splice(i, 1);
        }
        if (!node.a.length) node.a = null;
    }

    function upsertNodeEntry(node, rec) {
        var next = { v: rec.v, p: rec.p | 0, s: rec.s || '', k: rec.k || '', o: rec.o | 0 };
        if (node.v === null) {
            setNodeWinner(node, next);
            return;
        }
        if (node.v === next.v) {
            if ((next.p | 0) > (node.p | 0) || (((next.p | 0) === (node.p | 0)) && ((next.o | 0) >= (node.o | 0)))) {
                setNodeWinner(node, next);
            }
            return;
        }

        var prevWinner = { v: node.v, p: node.p | 0, s: node.s || '', k: node.k || '', o: node.o | 0 };
        var replaceWinner = (next.p | 0) > (node.p | 0) || (((next.p | 0) === (node.p | 0)) && ((next.o | 0) >= (node.o | 0)));
        upsertNodeAlt(node, next);
        if (replaceWinner) {
            setNodeWinner(node, next);
            removeNodeAltValue(node, next.v);
            upsertNodeAlt(node, prevWinner);
        }
    }

    function buildTrie(entries) {
        var r = createNode();
        for (var i = 0; i < entries.length; i++) {
            var zh = entries[i][0], vi = entries[i][1], pri = entries[i][2] | 0, src = entries[i][3] || '', key = entries[i][4] || entries[i][0];
            var node = r;
            for (var j = 0; j < zh.length; j++) {
                if (!node.c[zh[j]]) node.c[zh[j]] = createNode();
                node = node.c[zh[j]];
            }
            upsertNodeEntry(node, { v: vi, p: pri, s: src, k: key, o: i });
        }
        return r;
    }

    function isVietPhraseSource(sourceName) {
        return /^VietPhrase_[12]\.txt$/i.test(sourceName || '');
    }

    function preferFirstAdjacentVietPhraseVariants(entries) {
        if (entries.length < 2) return entries;
        var out = [];
        var start = 0;
        while (start < entries.length) {
            var first = entries[start];
            var end = start + 1;
            while (end < entries.length &&
                entries[end][0] === first[0] &&
                (entries[end][2] | 0) === (first[2] | 0) &&
                (entries[end][3] || '') === (first[3] || '')) {
                end++;
            }
            if (end - start > 1 && isVietPhraseSource(first[3])) {
                for (var rev = end - 1; rev >= start; rev--) out.push(entries[rev]);
            } else {
                for (var idx = start; idx < end; idx++) out.push(entries[idx]);
            }
            start = end;
        }
        return out;
    }

    function parseTSV(tsv) {
        var entries = [];
        var start = 0;
        while (start < tsv.length) {
            var nl = tsv.indexOf('\n', start);
            if (nl === -1) break;
            var line = tsv.substring(start, nl);
            start = nl + 1;
            var t1 = line.indexOf('\t');
            if (t1 === -1) continue;
            var t2 = line.indexOf('\t', t1 + 1);
            if (t2 === -1) continue;
            var t3 = line.indexOf('\t', t2 + 1);
            var key = line.substring(0, t1);
            var value = line.substring(t1 + 1, t2);
            var priRaw = t3 === -1 ? line.substring(t2 + 1) : line.substring(t2 + 1, t3);
            var src = t3 === -1 ? '' : line.substring(t3 + 1);
            var values = /[\/|]/.test(value) ? extractMeaningVariants(value, key.length, src) : [value];
            if (!values.length) values = [extractMeaning(value)];
            for (var vi = 0; vi < values.length; vi++) {
                if (!values[vi]) continue;
                entries.push([key, values[vi], parseInt(priRaw, 10), src]);
            }
        }
        return preferFirstAdjacentVietPhraseVariants(entries);
    }

    // Extract clean Vietnamese meaning from raw dict value
    // Handles both standard format (value/alt) and extended format:
    //   ✚[pinyin] Hán Việt: XXX\n\t1. meaning1; meaning2\n\t2. ...\n✚[pinyin2] ...
    function extractMeaning(raw) {
        // Extended format: contains ✚[ (U+271A) or +[ prefix
        if (raw.indexOf('\u271A[') !== -1 || raw.indexOf('+[') !== -1) {
            // Try first numbered meaning \t1. across all readings
            var t1 = raw.indexOf('\\t1.');
            if (t1 !== -1) {
                var meat = raw.substring(t1 + 4).trim();
                // Cut at next \n\t or \n or //
                var end = meat.search(/\\n|\/\//);
                if (end !== -1) meat = meat.substring(0, end);
                // Take first meaning before ;
                var semi = meat.indexOf(';');
                if (semi !== -1) meat = meat.substring(0, semi);
                // Strip parenthetical notes for cleaner output
                meat = meat.replace(/\s*\(.*?\)\s*/g, ' ').trim();
                if (meat) return meat;
            }
            // Fallback: extract Hán Việt reading
            var hv = raw.indexOf('Hán Việt:');
            if (hv !== -1) {
                var hvVal = raw.substring(hv + 9).trim();
                var hvEnd = hvVal.search(/\\[nt]|\/\//);
                if (hvEnd !== -1) hvVal = hvVal.substring(0, hvEnd);
                hvVal = hvVal.split(/[;；]/)[0].trim();
                hvVal = unwrapHanVietGloss(hvVal);
                if (hvVal) return hvVal;
            }
            // Fallback: strip ✚[...] / +[...] prefix, take direct meaning
            var stripped = raw.replace(/[\u271A+]\s*\[[^\]]*\]\s*/g, '');
            // Remove "Hán Việt: XXX " prefix if present
            stripped = stripped.replace(/Hán Việt:\s*\S+\s*/g, '').trim();
            // Clean literal escape sequences
            stripped = stripped.replace(/\\[nt]/g, ' ').trim();
            if (stripped) {
                var semi2 = stripped.indexOf(';');
                if (semi2 !== -1) stripped = stripped.substring(0, semi2).trim();
                stripped = stripped.replace(/\s*\(.*?\)\s*/g, ' ').trim();
                if (stripped) return stripped;
            }
        }
        // Standard format: split by // first, then / or | for alternatives
        var dslash = raw.indexOf('//');
        var first = dslash !== -1 ? raw.substring(0, dslash).trim() : raw;
        var alt = first.search(/[\/|]/);
        return alt !== -1 ? first.substring(0, alt).trim() : first;
    }

    function unwrapHanVietGloss(raw) {
        var trimmed = (raw || '').trim();
        if (!trimmed) return '';
        var parts = trimmed.split(/\s+/);
        var idx = 0;
        while (idx < parts.length && VI_ALL_CAPS_TOKEN_RE.test(parts[idx])) idx++;
        if (idx > 0 && idx < parts.length) return parts.slice(idx).join(' ').trim();
        return trimmed;
    }

    function titleCaseVietnamese(raw) {
        return (raw || '').replace(/(^|\s)(\S)/g, function (m, pre, ch) {
            return pre + ch.toUpperCase();
        });
    }

    function hasCJKText(text) {
        text = String(text || '');
        for (var i = 0; i < text.length; i++) {
            if (isCJK(text[i])) return true;
        }
        return false;
    }

    function getKinshipAliasSuffixPair(zh) {
        zh = String(zh || '');
        for (var i = 0; i < KINSHIP_ALIAS_SUFFIX_TRANSLATIONS.length; i++) {
            var pair = KINSHIP_ALIAS_SUFFIX_TRANSLATIONS[i];
            if (zh === pair[0] || (zh.length > pair[0].length && zh.slice(-pair[0].length) === pair[0])) return pair;
        }
        return null;
    }

    function renderHanvietChars(zh) {
        var parts = [];
        for (var i = 0; i < zh.length; i++) {
            parts.push(phienamMap.get(zh[i]) || zh[i]);
        }
        return parts.join(' ');
    }

    function renderHanvietTitleAlias(zh) {
        zh = String(zh || '');
        var suffixPair = getKinshipAliasSuffixPair(zh);
        if (!suffixPair) return '';
        if (zh === suffixPair[0]) return capitalizeSentences(suffixPair[1]);
        var prefix = zh.substring(0, zh.length - suffixPair[0].length);
        var prefixVi = renderHanvietChars(prefix);
        if (!prefixVi || hasCJKText(prefixVi)) return '';
        return titleCaseVietnamese(prefixVi) + ' ' + suffixPair[1];
    }

    function hanvietTitleTerm(zh) {
        var simplified = convertToSimplified(zh);
        var titleAlias = renderHanvietTitleAlias(simplified);
        if (titleAlias) return titleAlias;
        return titleCaseVietnamese(renderHanvietChars(simplified));
    }

    function normalizeMarkedTermQuote(open, close) {
        if (open === '\u300A' || close === '\u300B') return ['\u300A', '\u300B'];
        if (open === '\u300E' || close === '\u300F') return ['\u300E', '\u300F'];
        if (open === '\u300C' || close === '\u300D') return ['\u300C', '\u300D'];
        return ['\u201C', '\u201D'];
    }

    function hasHighPriorityTrieExact(zh) {
        if (!root || !zh) return false;
        var node = root;
        for (var i = 0; i < zh.length; i++) {
            node = node.c[zh[i]];
            if (!node) return false;
        }
        if (node.v !== null && (node.p | 0) >= 20) return true;
        if (node.a) {
            for (var ai = 0; ai < node.a.length; ai++) {
                if ((node.a[ai].p | 0) >= 20) return true;
            }
        }
        return false;
    }

    function hasOverlayExact(overlayIndex, zh) {
        if (!overlayIndex || !zh) return false;
        var bucket = overlayIndex[zh[0]];
        if (!bucket || !bucket.length) return false;
        for (var i = 0; i < bucket.length; i++) {
            if (bucket[i] && bucket[i].zh === zh) return true;
        }
        return false;
    }

    function isPostColonMarkedDialogue(open, prev) {
        if (prev !== ':' && prev !== '\uFF1A') return false;
        return /[\u201C\u2018"'\u300C\u300E\u300A]/.test(open || '');
    }

    function isLikelyQuotedDialogueText(zh) {
        if (!zh || zh.length < 3) return false;
        if (zh.length >= 5 && /[你我他她它咱您]/.test(zh)) return true;
        if (zh.length >= 5 && /(?:说|說|问|問|喊|叫|看|想|要|是|有|没|沒|怎么|怎麼|什么|什麼|为何|為何)/.test(zh)) return true;
        if (/[吗嗎么麼嘛呢吧啊呀啦]$/.test(zh)) return true;
        return false;
    }

    function protectMarkedHanVietTerms(text, overlayIndex) {
        return text.replace(/([\u201C\u2018"'\u300C\u300E\u300A])([\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]{2,10})([\u201D\u2019"'\u300D\u300F\u300B])/g, function (m, open, zh, close, offset, full) {
            var prev = offset > 0 ? full[offset - 1] : '';
            if (isPostColonMarkedDialogue(open, prev)) return m;
            if (isLikelyQuotedDialogueText(zh)) return m;
            if (/[的了地得着著过過]/.test(zh)) return m;
            if (hasOverlayExact(overlayIndex, zh) || hasHighPriorityTrieExact(zh)) return m;
            var quote = normalizeMarkedTermQuote(open, close);
            return quote[0] + hanvietTitleTerm(zh) + quote[1];
        });
    }

    function normalizeMeaningVariant(value) {
        return (value || '').replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
    }

    function looksLikeVerbishValue(value) {
        var trimmed = (value || '').trim();
        if (!trimmed) return false;
        if (VI_VERBISH_START_RE.test(trimmed)) return true;
        if (/^(?:chiếm|cướp|đoạt|diệt|tiêu diệt|hủy|phá|giành)\b/i.test(trimmed)) return true;
        return false;
    }

    function extractMeaningVariants(raw, keyLen, sourceName) {
        if (raw.indexOf('\u271A[') !== -1 || raw.indexOf('+[') !== -1) return [extractMeaning(raw)];
        var dslash = raw.indexOf('//');
        var first = dslash !== -1 ? raw.substring(0, dslash).trim() : raw.trim();
        if (!first) return [];
        var canSplit = isVietPhraseSource(sourceName) && keyLen >= 2;
        if (!canSplit) return [normalizeMeaningVariant(extractMeaning(first))];

        var parts = first.split(/[\/|]/);
        if (parts.length <= 1) return [normalizeMeaningVariant(first)];

        var out = [];
        var limit = keyLen <= 2 ? MAX_SIMPLE_MEANING_ALTS : 2;
        for (var i = 0; i < parts.length; i++) {
            var norm = normalizeMeaningVariant(parts[i]);
            if (!norm) continue;
            if (out.indexOf(norm) !== -1) continue;
            out.push(norm);
            if (out.length >= limit) break;
        }
        return out.length ? out : [normalizeMeaningVariant(first)];
    }

    // Load Traditional→Simplified mapping file
    function loadTradSimp() {
        return fetch('dicts/trad-simp.txt').then(function(r) { return r.text(); })
            .then(function(raw) {
                var cleaned = raw.replace(/^\uFEFF/, '').replace(/[\r\n\s]/g, '');
                // Use Array.from for codepoint-aware iteration (handles surrogate pairs)
                var codepoints = Array.from(cleaned);
                if (codepoints.length % 2 !== 0) {
                    console.warn('DictEngine: trad-simp.txt has odd codepoint count, skipping last');
                    codepoints.pop();
                }
                tradSimpMap = new Map();
                for (var i = 0; i < codepoints.length; i += 2)
                    tradSimpMap.set(codepoints[i], codepoints[i + 1]);
                console.log('DictEngine: loaded', tradSimpMap.size, 'trad→simp mappings');
            }).catch(function(e) { console.warn('DictEngine: trad-simp load failed', e); tradSimpMap = null; });
    }

    // Convert Traditional Chinese text to Simplified
    function convertToSimplified(text) {
        if (!tradSimpMap || !chuyenGianThe) return text;
        var out = '';
        // Use for...of for codepoint-aware iteration (handles surrogate pairs)
        for (var ch of text) {
            if (ch === '么') out += ch;
            else out += tradSimpMap.get(ch) || ch;
        }
        return out;
    }

    // Check if {0} capture is allowed by ThuatToanNhan mode
    function isCaptureAllowed(capText, matchPri) {
        if (thuatToanNhan === 0) return false;
        if (pronounSet.has(capText)) return true;
        if (thuatToanNhan >= 2 && matchPri >= 20) return true;
        if (thuatToanNhan >= 3 && matchPri >= 10) return true;
        return false;
    }

    function countDictRecords(text) {
        var count = 0;
        var lines = text.split('\n');
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line || line[0] === '#' || (line[0] === '/' && line[1] === '/')) continue;
            if (line.indexOf('=') >= 1) count++;
        }
        return count;
    }

    function parseDictText(text, priority, sourceName) {
        var entries = [];
        var lines = text.split('\n');
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line || line[0] === '#' || (line[0] === '/' && line[1] === '/')) continue;
            var eq = line.indexOf('=');
            if (eq < 1) continue;
            var zh = line.substring(0, eq).trim();
            var viRaw = line.substring(eq + 1).trim();
            if (zh.indexOf('{0}') !== -1) {
                entries.push([zh, viRaw.replace(/\s*\*$/, ''), priority, sourceName || '']);  // strip trailing *
            } else {
                var variants = extractMeaningVariants(viRaw, zh.length, sourceName);
                if (!variants.length) variants = [extractMeaning(viRaw)];
                for (var viIdx = 0; viIdx < variants.length; viIdx++) {
                    if (variants[viIdx]) entries.push([zh, variants[viIdx], priority, sourceName || '']);
                }
            }
        }
        return entries;
    }

    // Chinese → Latin punctuation normalization
    var CN_PUNCT_MAP = {
        '，': ',', '。': '.', '？': '?', '！': '!', '；': ';', '：': ':',
        '「': '\u201C', '」': '\u201D', '『': '\u2018', '』': '\u2019',
        '《': '\u00AB', '》': '\u00BB', '（': '(', '）': ')',
        '【': '[', '】': ']', '〈': '<', '〉': '>',
        '、': ',', '～': '~'
    };
    var CN_PUNCT_RE = /[，。？！；：「」『』《》（）【】〈〉、～]/g;

    function normalizePunctuation(str) {
        // Double patterns first: …… → ... and —— → —
        str = str.replace(/……/g, '...').replace(/——/g, '\u2014');
        // Single ellipsis
        str = str.replace(/…/g, '...');
        // Single char replacements
        return str.replace(CN_PUNCT_RE, function (ch) { return CN_PUNCT_MAP[ch] || ch; });
    }

    // Normalize line breaks: trim whitespace around \n, collapse 3+ blank lines to 2
    function cleanLineBreaks(str) {
        str = str.replace(/\r\n/g, '\n');          // Windows → Unix
        str = str.replace(/[ \t]*\n[ \t]*/g, '\n'); // trim spaces around \n
        str = str.replace(/\n{3,}/g, '\n\n');       // collapse 3+ newlines → 2
        return str;
    }

    // Capitalize first letter of each sentence (after .!? or newline, or after a
    // dialog colon like 'X said: "lower' -> 'X said: "Lower'). Also ensures a
    // single space after the colon when an opening quote follows.
    function capitalizeSentences(str) {
        // Insert missing space between a dialog colon and an opening quote
        // (ASCII " ' or curly “ ‘ 「 『). Skip if a space already exists.
        str = str.replace(/([:：])(?=["'“‘「『])/gu, '$1 ');
        // Cap after sentence-ending punctuation or newline.
        str = str.replace(/(^|[.!?\n]\s*)([a-zàáạảãăắằặẳẵâấầậẩẫđèéẹẻẽêếềệểễìíịỉĩòóọỏõôốồộổỗơớờợởỡùúụủũưứừựửữỳýỵỷỹ])/gu, function (m, pre, ch) {
            return pre + ch.toUpperCase();
        });
        // Cap after dialog colon + optional space + opening quote.
        str = str.replace(/([:：]\s*["'“‘「『]\s*)([a-zàáạảãăắằặẳẵâấầậẩẫđèéẹẻẽêếềệểễìíịỉĩòóọỏõôốồộổỗơớờợởỡùúụủũưứừựửữỳýỵỷỹ])/gu, function (m, pre, ch) {
            return pre + ch.toUpperCase();
        });
        // Chapter headings are emitted as "Chương 722: title"; title should
        // start as a Vietnamese sentence, unlike ordinary inline colons.
        str = str.replace(/(\bChương\s+\d+\s*:\s*)([a-zàáạảãăắằặẳẵâấầậẩẫđèéẹẻẽêếềệểễìíịỉĩòóọỏõôốồộổỗơớờợởỡùúụủũưứừựửữỳýỵỷỹ])/gu, function (m, pre, ch) {
            return pre + ch.toUpperCase();
        });
        return str;
    }

    // ===== LuatNhan Pattern Matching =====

    function buildPatterns(patEntries) {
        if (!patEntries || patEntries.length === 0) {
            patPrefixRoot = null;
            patSuffixRoot = null;
            hasPatterns = false;
            return;
        }
        patPrefixRoot = { c: Object.create(null) };
        patSuffixRoot = { c: Object.create(null) };
        var prefixCount = 0, suffixCount = 0;
        for (var i = 0; i < patEntries.length; i++) {
            var pe = patEntries[i];
            if (pe.prefix.length > 0) {
                // Insert prefix into patPrefixRoot Trie
                var node = patPrefixRoot;
                for (var j = 0; j < pe.prefix.length; j++) {
                    if (!node.c[pe.prefix[j]]) node.c[pe.prefix[j]] = { c: Object.create(null) };
                    node = node.c[pe.prefix[j]];
                }
                if (!node.patterns) node.patterns = [];
                node.patterns.push({ suffix: pe.suffix, template: pe.template });
                prefixCount++;
            } else {
                // suffix-only: {0}xxx=yyy — insert suffix into patSuffixRoot
                var node2 = patSuffixRoot;
                for (var k = 0; k < pe.suffix.length; k++) {
                    if (!node2.c[pe.suffix[k]]) node2.c[pe.suffix[k]] = { c: Object.create(null) };
                    node2 = node2.c[pe.suffix[k]];
                }
                if (!node2.templates) node2.templates = [];
                node2.templates.push(pe.template);
                suffixCount++;
            }
        }
        hasPatterns = prefixCount > 0 || suffixCount > 0;
        console.log('DictEngine: patterns loaded — prefix:', prefixCount, 'suffix-only:', suffixCount);
    }

    // Trie-only longest match at a position (no pattern recursion)
    function trieMatchAt(pos, text) {
        if (!root) return null;
        var node = root, lastMatch = -1, lastValue = null, lastPri = 0, j = pos;
        while (j < text.length && node.c[text[j]]) {
            node = node.c[text[j]]; j++;
            if (node.v !== null) { lastMatch = j; lastValue = node.v; lastPri = node.p; }
        }
        if (lastMatch > pos) return { end: lastMatch, value: lastValue, pri: lastPri };
        return null;
    }

    function startsWithPronounSource(text) {
        var max = Math.min(4, text.length);
        for (var len = max; len >= 1; len--) {
            if (pronounSet.has(text.substring(0, len))) return true;
        }
        return false;
    }

    function sourceWithoutTrailingDe(text) {
        var source = String(text || '');
        if (source[source.length - 1] === '的') source = source.substring(0, source.length - 1);
        return source;
    }

    function isPronounPossessiveSource(text) {
        var source = sourceWithoutTrailingDe(text);
        return pronounSet.has(source) || pronounLikePossessorSet.has(source) || /^(?:你|我|他|她|它|咱|您){2,4}$/.test(source);
    }

    function endsWithPronounSource(text, end) {
        var min = Math.max(0, end - 4);
        for (var start = min; start < end; start++) {
            if (pronounSet.has(text.substring(start, end))) return true;
        }
        return false;
    }

    function previousSourceChar(text, start) {
        for (var i = start - 1; i >= 0; i--) {
            if (text[i] !== ' ' && text[i] !== '\n' && text[i] !== '\t') return text[i];
        }
        return '';
    }

    function nextSourceChar(text, end) {
        for (var i = end; i < text.length; i++) {
            if (text[i] !== ' ' && text[i] !== '\n' && text[i] !== '\t') return text[i];
        }
        return '';
    }

    function isClauseBoundaryChar(ch) {
        return !ch || /[，。？！；：,.!?;:…—\)\]\u00BB\u201D\u2019>」』】〉]/.test(ch);
    }

    function isOpeningQuoteChar(ch) {
        return !!ch && /[\u201C\u2018"'「『《]/.test(ch);
    }

    function isSpeechDelimiterChar(ch) {
        return !!ch && /[：:「『“"']/.test(ch);
    }

    function isFirstVietPhraseVariant(entry) {
        if (!entry || (entry.rank | 0) !== 0) return false;
        return entry.src === 'VietPhrase_1.txt' || entry.src === 'VietPhrase_2.txt';
    }

    function shouldUseStationNounValue(searchState, start, end, value) {
        if ((value || '').trim() !== 'đứng') return false;
        if (searchState.text.substring(start, end) !== '站') return false;
        var next = nextSourceChar(searchState.text, end);
        if (!isClauseBoundaryChar(next) && !/^(?:呗|唄|吧|啊|呀|嘛|呢|啦)$/.test(next)) return false;
        return /[A-Za-z0-9]/.test(previousSourceChar(searchState.text, start));
    }

    function isSpeechTagExactValue(source, value) {
        if (!source || source[source.length - 1] !== '道') return false;
        return /(?:nói|hỏi|cười|đáp|quát|hét|mắng|than|thản nhiên|nhàn nhạt|ngạc nhiên)\b/i.test(value || '');
    }

    function isLatinAlphanumeric(ch) {
        return !!ch && /[A-Za-z0-9]/.test(ch);
    }

    function isParticleNeighbor(ch) {
        return isCJK(ch) || isLatinAlphanumeric(ch);
    }

    function isParticleBridgeContext(prev, next) {
        return !!prev && !!next && isParticleNeighbor(prev) && isParticleNeighbor(next) && !isClauseBoundaryChar(prev) && !isClauseBoundaryChar(next);
    }

    function isNumericCapture(text) {
        return !!text && NUMERIC_CAPTURE_RE.test(text.replace(/\s+/g, ''));
    }

    function isChapterLikeSource(text) {
        return !!text && CHAPTER_PATTERN_RE.test(text.replace(/\s+/g, ''));
    }

    function isPatternCaptureAllowed(captureText, matchPri, prefix, suffix) {
        if (isCaptureAllowed(captureText, matchPri)) return true;
        if (isNumericCapture(captureText) && ((prefix && prefix.length) || (suffix && suffix.length))) return true;
        return false;
    }

    function weakOutputPenalty(zh, value, candType) {
        if (value == null) return 120;
        if (value === '') return candType === 'exact' ? 6 : 18;
        var penalty = 0;
        var trimmed = value.trim();
        if (!trimmed) return candType === 'exact' ? 10 : 22;
        if (trimmed.indexOf('  ') !== -1) penalty += 3;
        if (/[A-ZÀÁẠẢÃĂẮẰẶẲẴÂẤẦẬẨẪĐÈÉẸẺẼÊẾỀỆỂỄÌÍỊỈĨÒÓỌỎÕÔỐỒỘỔỖƠỚỜỢỞỠÙÚỤỦŨƯỨỪỰỬỮỲÝỴỶỸ]/.test(trimmed) && trimmed === trimmed.toUpperCase()) penalty += 24;
        if (startsWithPronounSource(zh) && VI_PRONOUN_END_RE.test(trimmed) && !VI_PRONOUN_START_RE.test(trimmed)) penalty += 28;
        if (startsWithPronounSource(zh) && candType === 'exact' && /^(?:cầm|đi|ở|trong|với|đang|đã|sẽ)\b/i.test(trimmed)) penalty += 10;
        if (isChapterLikeSource(zh) && /\bchương\b/i.test(trimmed) && trimmed.toLowerCase().indexOf('thứ') === -1 && !/:$/.test(trimmed)) penalty += 55;
        if (zh.indexOf('了') !== -1 && STANDALONE_LIEU_RE.test(trimmed)) penalty += 520;
        if ((zh === '的' || zh.length > 2) && zh.indexOf('的') !== -1 && STANDALONE_DICH_RE.test(trimmed)) penalty += 520;
        return penalty;
    }

    function normalizeOverlayEntries(overlayEntries) {
        var normalized = [];
        if (!overlayEntries || !overlayEntries.length) return normalized;
        var bestByKey = Object.create(null);

        for (var i = 0; i < overlayEntries.length; i++) {
            var entry = overlayEntries[i] || {};
            var zh = convertToSimplified(String(entry.zh || entry.key || '').trim());
            var value = String(entry.vi || entry.value || '').trim();
            var overlayKind = String(entry.overlayKind || entry.target || '');
            var src = String(entry.src || 'overlay');
            var pri = parseInt(entry.pri, 10);

            if (!zh || !value) continue;
            if (overlayKind !== 'Book Names' && overlayKind !== 'Book VietPhrase') {
                overlayKind = entry.category === 'character' || entry.category === 'location' || entry.category === 'sect_org' || entry.category === 'title_alias'
                    ? 'Book Names'
                    : 'Book VietPhrase';
            }
            if (!isFinite(pri)) pri = overlayKind === 'Book Names' ? 30 : 25;

            var key = zh + '\u0000' + value;
            var next = {
                zh: zh,
                value: value,
                pri: pri | 0,
                src: src,
                key: zh,
                overlayKind: overlayKind,
                rank: 0
            };
            if (!bestByKey[key] || compareNodeEntries(next, bestByKey[key]) < 0) bestByKey[key] = next;
        }

        for (var key2 in bestByKey) {
            if (Object.prototype.hasOwnProperty.call(bestByKey, key2)) normalized.push(bestByKey[key2]);
        }
        normalized.sort(function (a, b) {
            if (b.zh.length !== a.zh.length) return b.zh.length - a.zh.length;
            if ((b.pri | 0) !== (a.pri | 0)) return (b.pri | 0) - (a.pri | 0);
            return String(a.zh).localeCompare(String(b.zh), 'zh-Hans-CN');
        });
        return normalized;
    }

    function buildOverlayIndex(entries) {
        if (!entries || !entries.length) return null;
        var index = Object.create(null);
        for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            if (!entry || !entry.zh) continue;
            var ch = entry.zh[0];
            if (!index[ch]) index[ch] = [];
            index[ch].push(entry);
        }
        for (var key in index) {
            if (!Object.prototype.hasOwnProperty.call(index, key)) continue;
            index[key].sort(function (a, b) {
                if (b.zh.length !== a.zh.length) return b.zh.length - a.zh.length;
                if ((b.pri | 0) !== (a.pri | 0)) return (b.pri | 0) - (a.pri | 0);
                return String(a.value).localeCompare(String(b.value), 'vi');
            });
        }
        return index;
    }

    var __overlayCache = null;

    function overlayCacheSignature(rawOverlay) {
        if (!rawOverlay || !rawOverlay.length) return '';
        var parts = [String(rawOverlay.length)];
        for (var i = 0; i < rawOverlay.length; i++) {
            var item = rawOverlay[i] || {};
            parts.push([
                item.zh || item.key || '',
                item.vi || item.value || '',
                item.pri == null ? '' : item.pri,
                item.overlayKind || item.target || '',
                item.category || '',
                item.src || ''
            ].join('\u0002'));
        }
        return parts.join('\u0001');
    }

    function getOverlayBundle(rawOverlay) {
        if (!rawOverlay || !rawOverlay.length) {
            __overlayCache = null;
            return { normalized: [], index: null };
        }
        var signature = overlayCacheSignature(rawOverlay);
        if (__overlayCache && __overlayCache.raw === rawOverlay && __overlayCache.signature === signature) {
            return { normalized: __overlayCache.normalized, index: __overlayCache.index };
        }
        var normalized = normalizeOverlayEntries(rawOverlay);
        var index = buildOverlayIndex(normalized);
        __overlayCache = { raw: rawOverlay, signature: signature, normalized: normalized, index: index };
        return { normalized: normalized, index: index };
    }

    function createSearchState(text, originalText, opts) {
        opts = opts || {};
        var overlayBundle = opts._overlayBundle || getOverlayBundle(opts.overlayEntries);
        return {
            text: text,
            originalText: originalText || text,
            candidateCache: Object.create(null),
            subspanCache: Object.create(null),
            runtimeNameDetect: opts.runtimeNameDetect === true,
            overlayEntries: overlayBundle.normalized,
            overlayIndex: overlayBundle.index
        };
    }

    function makeEmptySearchResult() {
        return {
            text: '',
            score: 0,
            tokenCount: 0,
            fallbackCount: 0,
            rawCount: 0,
            exactChars: 0,
            strongExactCount: 0,
            singleCount: 0
        };
    }

    function isEmbeddedPronounPossessiveExact(text, start, simpSpan) {
        if (!simpSpan) return false;
        var ownerLength = 0;
        var maxOwnerLength = Math.min(4, simpSpan.length - 1);
        for (var len = maxOwnerLength; len >= 1; len--) {
            if (simpSpan[len] === '的' && pronounSet.has(simpSpan.substring(0, len))) {
                ownerLength = len;
                break;
            }
        }
        if (!ownerLength) return false;
        if (start <= 0 || !isCJK(text[start - 1])) return false;
        var previousMatch = trieMatchAt(start - 1, text);
        return !!(previousMatch && previousMatch.end > start && previousMatch.end <= start + ownerLength);
    }

    function exactContextAdjustment(searchState, start, end, trimmed, entry, len) {
        var text = searchState.text;
        var bonus = 0;
        var prev = previousSourceChar(text, start);
        var next = nextSourceChar(text, end);
        var simpSpan = text.substring(start, end);
        var originalSpan = (searchState.originalText || text).substring(start, end);
        var isVerbish = looksLikeVerbishValue(trimmed);
        var isNounish = VI_NOUNISH_START_RE.test(trimmed);

        if ((entry.rank | 0) > 0) bonus -= Math.min(12, (entry.rank | 0) * 3);
        if (entry.src === 'LacViet.txt' && len <= 2) bonus += 4;
        if ((entry.src === 'VietPhrase_1.txt' || entry.src === 'VietPhrase_2.txt') && len <= 2 && trimmed.indexOf(' ') !== -1) bonus -= 2;
        if (isFirstVietPhraseVariant(entry) && isSpeechTagExactValue(simpSpan, trimmed) && isSpeechDelimiterChar(next)) bonus += 48;
        if (len === 1 && entry.src && entry.src !== 'dict-default.json' && entry.src !== 'Names.txt') bonus -= 18;
        if (entry.overlayKind === 'Book Names') bonus += 8;
        else if (entry.overlayKind === 'Book VietPhrase') bonus += 4;
        if (startsWithPronounSource(simpSpan) && len <= 2 && trimmed && !VI_PRONOUN_START_RE.test(trimmed) && !/^(?:của|cho|đối với|về|theo|thuộc về|trên)\b/i.test(trimmed)) bonus -= 24;
        if (entry.key && entry.key !== simpSpan) {
            if (originalSpan === entry.key) {
                bonus += len === 1 ? 24 : 12;
            } else if (originalSpan === simpSpan) {
                bonus -= len === 1 ? 36 : 16;
            } else {
                bonus -= len === 1 ? 20 : 10;
            }
        }
        var embeddedDePos = simpSpan.indexOf('的');
        if (len >= 4 && embeddedDePos > 0 && embeddedDePos < len - 1) {
            var embeddedModifierSource = simpSpan.substring(0, embeddedDePos);
            if (isAttributiveAdjectiveSource(embeddedModifierSource)) {
                bonus += 36;
            }
        }
        if (isEmbeddedPronounPossessiveExact(text, start, simpSpan)) bonus -= 220;
        if (len === 1 && originalSpan === simpSpan) {
            if ((simpSpan === '将' || simpSpan === '把') && isDisposalMarkerContext(searchState, start, end)) {
                if (/^(?:đem|lấy|mang)$/i.test(trimmed)) bonus += 22;
                else if (/^(?:sẽ|sắp|tương)$/i.test(trimmed)) bonus -= 26;
            }
            if (simpSpan === '了' && (isClauseBoundaryChar(next) || isOpeningQuoteChar(next))) {
                if (!trimmed) bonus += 26;
                else if (/^(?:liễu|liệu|LIỄU|LIÊU)$/i.test(trimmed)) bonus -= 360;
            }
            if (simpSpan === '了' && isParticleBridgeContext(prev, next)) {
                if (!trimmed) bonus += 22;
                else if (/^(?:liễu|liệu|LIỄU|LIÊU)$/i.test(trimmed)) bonus -= 340;
            }
            if (simpSpan === '的' && isParticleBridgeContext(prev, next) && !endsWithPronounSource(text, start)) {
                if (!trimmed) bonus += 24;
                else if (/^(?:đích|ĐÍCH)$/i.test(trimmed)) bonus -= 360;
                else if (/^(?:của)$/i.test(trimmed)) bonus -= 8;
            }
            if (simpSpan === '的' && (isParticleNeighbor(prev) || isParticleNeighbor(next))) {
                if (/^(?:đích|ĐÍCH)$/i.test(trimmed)) bonus -= 360;
            }
            if (simpSpan === '地' && isParticleBridgeContext(prev, next)) {
                if (!trimmed) bonus += 16;
                else if (/^(?:địa|ĐỊA|đất)$/i.test(trimmed)) bonus -= 12;
            }
            if (simpSpan === '着' && isCJK(prev) && (isCJK(next) || isClauseBoundaryChar(next))) {
                if (!trimmed) bonus += 14;
                else if (/^(?:trứ|chiêu|chiếu|đang)$/i.test(trimmed)) bonus -= 10;
            }
            if (simpSpan === '得' && isParticleBridgeContext(prev, next) && !endsWithPronounSource(text, start)) {
                if (!trimmed) bonus += 10;
                else if (/^(?:đắc|được)$/i.test(trimmed)) bonus -= 6;
            }
            if (simpSpan === '过' && isCJK(prev) && isClauseBoundaryChar(next)) {
                if (!trimmed) bonus += 10;
                else if (/^(?:quá|qua)$/i.test(trimmed)) bonus -= 8;
            }
        }
        if (len >= 2 && simpSpan[len - 1] === '的' && isCJK(next)) {
            if (/^(?:của)\b/i.test(trimmed)) bonus += 18;
            else if (startsWithPronounSource(simpSpan) && VI_PRONOUN_START_RE.test(trimmed)) bonus -= 18;
        }
        if (len >= 3 && startsWithPronounSource(simpSpan) && /^(?:trên|trong)\b/i.test(trimmed)) {
            bonus += 24;
        }

        if (prev === '的') {
            if (isVerbish) bonus -= 26;
            if (isNounish) bonus += 12;
        }
        if (next === '是' || next === '有') {
            if (isVerbish) bonus -= 14;
            if (isNounish) bonus += 6;
        }
        if (next === '了' || next === '着' || next === '過' || next === '过') {
            if (isVerbish) bonus += 8;
            if (isNounish) bonus -= 8;
        }
        if (prev === '把' || prev === '将' || prev === '拿' || prev === '用') {
            if (isNounish) bonus += 10;
            if (isVerbish) bonus -= 16;
        }
        return bonus;
    }

    function priorityBandScore(pri, entry) {
        if (pri >= 999) return 260;
        if (pri >= 25) return 96;
        if (pri >= 20) return 28;
        if (pri >= 10) return 8;
        if (entry && entry.overlayKind === 'Book Names') return 96;
        if (entry && entry.overlayKind === 'Book VietPhrase') return 84;
        return 0;
    }

    function isNameEntry(entry) {
        return !!entry && (entry.src === 'Names.txt' || entry.src === 'Names2.txt' || entry.overlayKind === 'Book Names');
    }

    function looksLikeLatinNameValue(value) {
        return /^[A-Z][A-Za-z']*(?:[ -][A-Z][A-Za-z']*)*$/.test((value || '').trim());
    }

    function exactPhraseCohesionBonus(value, entry, len, pri) {
        if (len < 2 || pri < 10) return 0;
        var bonus = (len - 1) * 12;
        if (len >= 4) bonus += 18;
        if (len >= 3 && isNameEntry(entry)) bonus += 72;
        if (looksLikeLatinNameValue(value)) bonus += len === 2 ? 84 : 56;
        return bonus;
    }

    function buildExactCandidate(searchState, start, end, entry) {
        var text = searchState.text;
        var zh = text.substring(start, end);
        var len = end - start;
        var value = entry.value;
        if (shouldUseStationNounValue(searchState, start, end, value)) value = 'trạm';
        var pri = entry.pri | 0;
        var trimmed = (value || '').trim();
        var score = len * 20 - 22;
        score += Math.min(90, pri * 4);
        score += priorityBandScore(pri, entry);
        score += len === 1 ? -8 : Math.min(40, len * len);
        if (pri >= 20) score += 14;
        if (len >= 2 && isNameEntry(entry)) score += len >= 3 ? 24 : 16;
        if (len >= 4) score += 12;
        score += exactPhraseCohesionBonus(value, entry, len, pri);
        score += exactContextAdjustment(searchState, start, end, trimmed, entry, len);
        score -= weakOutputPenalty(zh, value, 'exact');
        return {
            type: 'exact',
            start: start,
            end: end,
            len: len,
            value: value,
            pri: pri,
            score: score,
            compareLen: len,
            tokenCountInc: 1,
            fallbackCountInc: 0,
            rawCountInc: 0,
            exactCharsInc: len,
            strongExactCountInc: pri >= 20 ? 1 : 0,
            singleCountInc: len === 1 ? 1 : 0,
            source: entry.src || '',
            key: entry.key || zh,
            overlayKind: entry.overlayKind || ''
        };
    }

    function buildLiteralCandidate(text, start, end) {
        return {
            type: 'literal',
            start: start,
            end: end,
            len: end - start,
            value: text.substring(start, end),
            pri: 0,
            score: 0,
            compareLen: end - start,
            tokenCountInc: 0,
            fallbackCountInc: 0,
            rawCountInc: 0,
            exactCharsInc: 0,
            strongExactCountInc: 0,
            singleCountInc: 0
        };
    }

    function buildFallbackCandidate(text, pos) {
        var ch = text[pos];
        var hasPhienAm = phienamMap.has(ch);
        var score = hasPhienAm ? -12 : -38;
        if (hasPhienAm && ch === '了') {
            var next = nextSourceChar(text, pos + 1);
            if (isClauseBoundaryChar(next) || isOpeningQuoteChar(next)) score -= 20;
        }
        return {
            type: hasPhienAm ? 'fallback' : 'raw-char',
            start: pos,
            end: pos + 1,
            len: 1,
            value: hasPhienAm ? phienamMap.get(ch) : ch,
            pri: 0,
            score: score,
            compareLen: 1,
            tokenCountInc: 1,
            fallbackCountInc: hasPhienAm ? 1 : 0,
            rawCountInc: hasPhienAm ? 0 : 1,
            exactCharsInc: 0,
            strongExactCountInc: 0,
            singleCountInc: 1
        };
    }

    function runtimeNameSurnameAt(text, pos) {
        var doubleSurname = text.substring(pos, pos + 2);
        if (RUNTIME_DOUBLE_SURNAME_VI[doubleSurname]) {
            return { len: 2, vi: RUNTIME_DOUBLE_SURNAME_VI[doubleSurname], isDouble: true };
        }
        var singleSurname = text.charAt(pos);
        if (RUNTIME_CONTEXT_SINGLE_SURNAME_LOOKUP[singleSurname] && phienamMap.has(singleSurname)) {
            return { len: 1, vi: titleCaseVietnamese(phienamMap.get(singleSurname)), isDouble: false };
        }
        return null;
    }

    function exactCandidatesCoverRuntimeName(exactCandidates, start, minEnd) {
        for (var i = 0; i < exactCandidates.length; i++) {
            var candidate = exactCandidates[i];
            if (!candidate) continue;
            if (candidate.start === start && candidate.end >= minEnd) return true;
        }
        return false;
    }

    function runtimeNameSpanIsValid(text, start, end, surnameLen) {
        if (end <= start + surnameLen) return false;
        var given = text.substring(start + surnameLen, end);
        if (given.length < 1 || given.length > 2) return false;
        if (RUNTIME_NAME_BAD_GIVEN_WORDS[given]) return false;
        if (text.charAt(start - 1) === '大') return false;
        if ('王侯公君帝'.indexOf(text.charAt(end)) !== -1) return false;
        for (var i = start; i < end; i++) {
            var ch = text[i];
            if (!isCJK(ch) || !phienamMap.has(ch)) return false;
            if (i >= start + surnameLen && RUNTIME_NAME_STOP_CHARS.indexOf(ch) !== -1) return false;
            if (i >= start + surnameLen && RUNTIME_NAME_BAD_GIVEN_CHARS.indexOf(ch) !== -1) return false;
        }
        return true;
    }

    function runtimeNameRightContext(text, end) {
        for (var i = 0; i < RUNTIME_NAME_RIGHT_CONTEXT_CUES.length; i++) {
            var cue = RUNTIME_NAME_RIGHT_CONTEXT_CUES[i];
            if (text.substring(end, end + cue.length) === cue) return cue;
        }
        return '';
    }

    function runtimeNameLeftContext(text, start) {
        var prefix = text.substring(Math.max(0, start - 4), start);
        for (var i = 0; i < RUNTIME_NAME_LEFT_CONTEXT_CUES.length; i++) {
            var cue = RUNTIME_NAME_LEFT_CONTEXT_CUES[i];
            if (prefix.substring(prefix.length - cue.length) === cue) return cue;
        }
        return '';
    }

    function renderRuntimeNameValue(text, start, end, surnameInfo) {
        var parts = [surnameInfo.vi];
        for (var i = start + surnameInfo.len; i < end; i++) {
            parts.push(titleCaseVietnamese(phienamMap.get(text[i]) || text[i]));
        }
        return parts.join(' ');
    }

    function buildRuntimeNameDetectCandidate(searchState, pos, endLimit, exactCandidates) {
        if (!searchState.runtimeNameDetect) return null;
        var text = searchState.text;
        var surnameInfo = runtimeNameSurnameAt(text, pos);
        if (!surnameInfo) return null;
        var leftCueAtPos = runtimeNameLeftContext(text, pos);
        if (!surnameInfo.isDouble && isCJK(text.charAt(pos - 1)) && !leftCueAtPos) return null;
        var minEnd = pos + surnameInfo.len + 1;
        if (minEnd > endLimit) return null;
        if (exactCandidatesCoverRuntimeName(exactCandidates, pos, minEnd)) return null;

        var maxGiven = Math.min(2, endLimit - pos - surnameInfo.len);
        for (var givenLen = maxGiven; givenLen >= 1; givenLen--) {
            var end = pos + surnameInfo.len + givenLen;
            if (!runtimeNameSpanIsValid(text, pos, end, surnameInfo.len)) continue;
            var contextCue = runtimeNameRightContext(text, end) || leftCueAtPos;
            if (surnameInfo.isDouble && givenLen === 1 && !contextCue) continue;
            if (!surnameInfo.isDouble && !contextCue) continue;
            var len = end - pos;
            return {
                type: 'name-detect',
                start: pos,
                end: end,
                len: len,
                value: renderRuntimeNameValue(text, pos, end, surnameInfo),
                pri: 0,
                score: len * 20 - 22 + 145 + (surnameInfo.isDouble ? 8 : 0) + (contextCue ? 34 : 0),
                compareLen: len,
                tokenCountInc: 1,
                fallbackCountInc: 0,
                rawCountInc: 0,
                exactCharsInc: 0,
                strongExactCountInc: 0,
                singleCountInc: 0,
                source: 'runtime-name-detect',
                key: text.substring(pos, end),
                overlayKind: ''
            };
        }
        return null;
    }

    function matchKinshipAliasSuffix(text, pos, endLimit) {
        var maxEnd = Math.min(endLimit, pos + 6);
        for (var i = 0; i < KINSHIP_ALIAS_SUFFIX_TRANSLATIONS.length; i++) {
            var pair = KINSHIP_ALIAS_SUFFIX_TRANSLATIONS[i];
            var suffix = pair[0];
            var end = pos + suffix.length + 1;
            while (end <= maxEnd) {
                if (text.substring(end - suffix.length, end) === suffix) {
                    return { suffix: suffix, vi: pair[1], end: end };
                }
                end++;
            }
        }
        return null;
    }

    function isBareKinshipAliasTitle(span) {
        for (var i = 0; i < KINSHIP_ALIAS_SUFFIX_TRANSLATIONS.length; i++) {
            if (span === KINSHIP_ALIAS_SUFFIX_TRANSLATIONS[i][0]) return true;
        }
        return false;
    }

    function renderKinshipAliasPrefix(text, start, end) {
        var parts = [];
        for (var i = start; i < end; i++) {
            var ch = text[i];
            if (!isCJK(ch) || !phienamMap.has(ch)) return '';
            parts.push(titleCaseVietnamese(phienamMap.get(ch) || ch));
        }
        return parts.join(' ');
    }

    function buildKinshipAliasCandidate(searchState, pos, endLimit, exactCandidates) {
        var text = searchState.text;
        if (text[pos] === '的' || text[pos] === '了' || text[pos] === '地' || text[pos] === '得' || text[pos] === '着' || text[pos] === '著' || text[pos] === '过' || text[pos] === '過') return null;
        var match = matchKinshipAliasSuffix(text, pos, endLimit);
        if (!match) return null;
        var span = text.substring(pos, match.end);
        if (isBareKinshipAliasTitle(span)) return null;
        for (var ei = 0; exactCandidates && ei < exactCandidates.length; ei++) {
            var exact = exactCandidates[ei];
            if (exact && exact.start === pos && exact.end === match.end &&
                ((exact.pri | 0) >= 10 || exact.overlayKind === 'Book Names' || exact.overlayKind === 'Book VietPhrase')) {
                return null;
            }
        }
        var prefixEnd = match.end - match.suffix.length;
        if (prefixEnd <= pos) return null;
        var prefixLen = prefixEnd - pos;
        if (prefixLen > 2) return null;
        if (KINSHIP_ALIAS_PREFIX_STOP_RE.test(text.substring(pos, prefixEnd))) return null;
        var prefixValue = renderKinshipAliasPrefix(text, pos, prefixEnd);
        if (!prefixValue) return null;
        var len = match.end - pos;
        return {
            type: 'kinship-alias',
            start: pos,
            end: match.end,
            len: len,
            value: prefixValue + ' ' + match.vi,
            pri: 0,
            score: len * 20 - 22 + 430,
            compareLen: len,
            tokenCountInc: 1,
            fallbackCountInc: 0,
            rawCountInc: 0,
            exactCharsInc: 0,
            strongExactCountInc: 0,
            singleCountInc: 0,
            source: 'runtime-kinship-alias',
            key: span,
            overlayKind: ''
        };
    }

    function particleSkipScore(searchState, pos) {
        var text = searchState.text;
        var originalText = searchState.originalText || text;
        var ch = text[pos];
        var originalCh = originalText.substring(pos, pos + 1);
        var prev = previousSourceChar(text, pos);
        var next = nextSourceChar(text, pos + 1);
        if (!ch || originalCh !== ch) return null;

        if (ch === '了' && (isClauseBoundaryChar(next) || isOpeningQuoteChar(next))) return 18;
        if (ch === '了' && isClosingQuoteOrBracket(prev) && isParticleNeighbor(next)) return 16;
        if (ch === '了' && isParticleBridgeContext(prev, next)) return 16;
        if (ch === '的' && (isParticleNeighbor(prev) || isClosingQuoteOrBracket(prev)) && (isParticleNeighbor(next) || isOpeningQuoteChar(next))) return 20;
        if (ch === '的' && isClosingQuoteOrBracket(prev) && isClauseBoundaryChar(next)) return 18;
        if (ch === '的' && isParticleNeighbor(prev) && isClauseBoundaryChar(next)) return 18;
        if (ch === '的' && isParticleBridgeContext(prev, next)) return 20;
        if (ch === '地' && isParticleBridgeContext(prev, next)) return 14;
        if (ch === '着' && isCJK(prev) && (isCJK(next) || isClauseBoundaryChar(next))) return 12;
        if (ch === '得' && isParticleBridgeContext(prev, next) && !endsWithPronounSource(text, pos)) return 8;
        if (ch === '过' && isCJK(prev) && isClauseBoundaryChar(next)) return 8;
        return null;
    }

    function buildParticleSkipCandidate(searchState, pos) {
        var score = particleSkipScore(searchState, pos);
        if (score == null) return null;
        return {
            type: 'particle-skip',
            start: pos,
            end: pos + 1,
            len: 1,
            value: '',
            pri: 0,
            score: score,
            compareLen: 0,
            tokenCountInc: 0,
            fallbackCountInc: 0,
            rawCountInc: 0,
            exactCharsInc: 0,
            strongExactCountInc: 0,
            singleCountInc: 0
        };
    }

    function captureInfoFromCandidate(candidate) {
        return {
            text: candidate.value,
            score: candidate.score,
            tokenCount: candidate.tokenCountInc || 0,
            fallbackCount: candidate.fallbackCountInc || 0,
            rawCount: candidate.rawCountInc || 0,
            exactChars: candidate.exactCharsInc || 0,
            strongExactCount: candidate.strongExactCountInc || 0,
            singleCount: candidate.singleCountInc || 0
        };
    }

    function buildPatternCandidate(text, start, end, template, prefixLen, suffixLen, captureText, captureInfo, overlapPenalty, kind) {
        var zh = text.substring(start, end);
        var len = end - start;
        var value = template.replace('{0}', captureInfo.text);
        var score = len * 20 - 22;
        score += (prefixLen + suffixLen) * 4;
        score += Math.min(48, captureInfo.exactChars * 6);
        score += Math.min(36, captureInfo.strongExactCount * 14);
        if (captureInfo.tokenCount <= 1) score += 10;
        else score -= Math.max(0, captureInfo.tokenCount - 1) * 6;
        if (captureInfo.fallbackCount === 0 && captureInfo.rawCount === 0) score += 10;
        score -= captureInfo.fallbackCount * 16;
        score -= captureInfo.rawCount * 24;
        score -= overlapPenalty || 0;
        score -= 18;
        if (isChapterLikeSource(zh)) {
            score += 48;
            if (isNumericCapture(captureText)) score += 18;
            if (/\bthứ\b/i.test(value)) score += 10;
        }
        score -= weakOutputPenalty(zh, value, 'pattern');
        return {
            type: 'pattern',
            start: start,
            end: end,
            len: len,
            value: value,
            pri: 0,
            score: score,
            compareLen: kind === 'pattern-prefix' ? prefixLen : len,
            tokenCountInc: 1,
            fallbackCountInc: captureInfo.fallbackCount,
            rawCountInc: captureInfo.rawCount,
            exactCharsInc: captureInfo.exactChars,
            strongExactCountInc: captureInfo.strongExactCount,
            singleCountInc: captureInfo.singleCount,
            patternKind: kind
        };
    }

    function possessiveValueForCandidate(candidate) {
        var value = ((candidate && candidate.value) || '').trim();
        if (!value) return '';
        if (/^của\b/i.test(value)) return value;
        if (isPronounPossessiveSource(candidate && candidate.key) && VI_PRONOUN_START_RE.test(value)) return 'của ' + value;
        return '';
    }

    function isStrongPossessorCandidate(candidate) {
        if (!candidate || candidate.type !== 'exact') return false;
        var key = String(candidate.key || '');
        if (key[key.length - 1] === '的') key = key.substring(0, key.length - 1);
        if ((key.length || (candidate.len | 0)) < 2) return false;
        var value = ((candidate.value || '') + '').trim();
        if (!VI_UPPER_START_RE.test(value)) return false;
        if (looksLikeVerbishValue(value)) return false;
        if ((candidate.pri | 0) >= 20) return true;
        if (candidate.overlayKind === 'Book Names') return true;
        if (candidate.source === 'Names.txt') return true;
        if (candidate.source === 'VietPhrase_2.txt' && /^小[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]{1,2}$/.test(key) && /^Tiểu\s+\S/.test(value)) return true;
        return false;
    }

    function looksLikeNominalValue(value) {
        var trimmed = (value || '').trim();
        if (!trimmed) return false;
        if (VI_NOUNISH_START_RE.test(trimmed)) return true;
        if (/^(?:chuyện|xếp hạng|thứ hạng|tốc độ|trình độ|cấp bậc)(?:\s|$)/i.test(trimmed)) return true;
        if (/^(?:thanh|cây|con|bộ|quyển|pho|tên|kiếm|gươm|cửa|cổng|trận|pháp|người)(?:\s|$)/i.test(trimmed)) return true;
        return false;
    }

    function isPossessiveModifierCandidate(candidate) {
        var value = ((candidate && candidate.value) || '').trim();
        if (!candidate || candidate.type !== 'exact' || !value) return false;
        if ((candidate.pri | 0) >= 20 || candidate.overlayKind === 'Book Names') return false;
        if (looksLikeNominalValue(value)) return false;
        if (/^(?:của|cho|với|tại|ở|trong|trên)\b/i.test(value)) return false;
        return (candidate.len | 0) <= 4;
    }

    function isAttributiveAdjectiveSource(source) {
        if (!source || source.length < 2) return false;
        return /^(?:高|低|大|小|长|長|短|强|強|弱|新|旧|舊|红|紅|白|黑|蓝|藍|红色|紅色|白色|黑色|蓝色|藍色|金色|重要|复杂|複雜|简单|簡單|干净|乾淨|安静|安靜|漂亮|美丽|美麗|好看|高挑|强大|強大|弱小|普通|特殊|特别|特別|危险|危險|安全|陌生|熟悉|奇怪|平凡|鲜红|鮮紅|雪白|漆黑|蔚蓝|蔚藍|蓝汪汪|藍汪汪|大大小小|最低|最高|最简单|最簡單)$/.test(source || '');
    }

    function isAttributiveVerbSource(source) {
        if (!source || source.length < 2) return false;
        return /^(?:说话|說話|爱吃|愛吃|喜欢|喜歡|讨厌|討厭|拥有|擁有|生闷气|生悶氣|在生闷气|在生悶氣|抽烟|抽煙|吸烟|吸煙|看书|看書|读书|讀書|写字|寫字|开口|開口|回答|询问|詢問|提问|提問|说笑|說笑|做事|办事|辦事|工作|学习|學習|修炼|修煉|练功|練功|战斗|戰鬥|飞行|飛行|行走|奔跑|逃跑|出现|出現|消失|离开|離開|进入|進入|参加|參加|经过|經過|路过|路過|遇见|遇見|认识|認識|看到|听到|聽到|拿着|拿著|穿着|穿著|站着|站著|坐着|坐著|躺着|躺著)$/.test(source || '');
    }

    function isAttributiveAdjectiveCandidate(text, candidate) {
        if (!candidate || candidate.type !== 'exact') return false;
        if ((candidate.pri | 0) >= 20 || candidate.overlayKind === 'Book Names') return false;
        if (!isAttributiveAdjectiveSource(text.substring(candidate.start, candidate.end))) return false;
        if (/(?:长得|長得|长的|長的)$/.test(text.substring(Math.max(0, candidate.start - 2), candidate.start))) return false;
        var value = ((candidate.value || '') + '').trim();
        if (!value || looksLikeNominalValue(value) || looksLikeVerbishValue(value)) return false;
        if (/^(?:của|cho|với|tại|ở|trong|trên)\b/i.test(value)) return false;
        return true;
    }

    function isAttributiveVerbCandidate(text, candidate) {
        if (!candidate || candidate.type !== 'exact') return false;
        if ((candidate.pri | 0) >= 20 || candidate.overlayKind === 'Book Names') return false;
        var source = text.substring(candidate.start, candidate.end);
        if (!isAttributiveVerbSource(source)) return false;
        if (isAttributiveAdjectiveSource(source)) return false;
        if (/(?:我|你|他|她|它|咱|俺|您|我们|我們|你们|你們|他们|他們|她们|她們|它们|它們)$/.test(text.substring(Math.max(0, candidate.start - 2), candidate.start))) return false;
        if (/(?:尝试|嘗試|想|要|能|会|會|可|可以)$/.test(text.substring(Math.max(0, candidate.start - 2), candidate.start))) return false;
        if (/(?:正在|正|又|还|還)$/.test(text.substring(Math.max(0, candidate.start - 2), candidate.start))) return false;
        var value = ((candidate.value || '') + '').trim();
        if (!value || looksLikeNominalValue(value)) return false;
        if (/^(?:của|cho|với|tại|ở|trong|trên)\b/i.test(value)) return false;
        return looksLikeVerbishValue(value) || /^(?:nói|thích|ghét|yêu|có|đang|hút|đọc|viết|mở miệng|trả lời|hỏi|làm|học|tu|luyện|chiến đấu|phi hành|đi|chạy|xuất hiện|biến mất|rời|tiến vào|tham gia|đi qua|gặp|quen|nhìn thấy|nghe thấy|cầm|mặc|đứng|ngồi|nằm|hờn|giận)\b/i.test(value);
    }

    function isAttributiveModifierHeadCandidate(text, candidate) {
        if (!candidate || candidate.type !== 'exact') return false;
        if ((candidate.pri | 0) >= 20 || candidate.overlayKind === 'Book Names') return false;
        var value = ((candidate.value || '') + '').trim();
        if (!value || looksLikeVerbishValue(value)) return false;
        if (looksLikeNominalValue(value)) return true;
        var source = text.substring(candidate.start, candidate.end);
        return /(?:人|者|子|女|男|东西|東西|物|事|房|房间|房間|屋|衣服|天气|天氣|剑|劍|刀|循环|循環|声音|聲音|神色|模样|模樣|地方|气息|氣息)$/.test(source);
    }

    function isVerbRelativeHeadCandidate(text, candidate) {
        if (isAttributiveModifierHeadCandidate(text, candidate)) return true;
        if (!candidate || candidate.type !== 'exact') return false;
        if ((candidate.pri | 0) >= 20 || candidate.overlayKind === 'Book Names') return false;
        var value = ((candidate.value || '') + '').trim();
        if (!value || looksLikeVerbishValue(value)) return false;
        if (text[candidate.end] === '们' || text[candidate.end] === '們') return false;
        var source = text.substring(candidate.start, candidate.end);
        if (/^(?:学生|學生|高中生|小学生|小學生|中学生|中學生|大学生|大學生)$/.test(source)) return true;
        return /^(?:học sinh|sinh viên)\b/i.test(value);
    }

    function hasExactCandidateCrossingParticle(exactCandidates, particlePos) {
        for (var i = 0; i < exactCandidates.length; i++) {
            if (exactCandidates[i].type === 'exact' && exactCandidates[i].end > particlePos + 1) return true;
        }
        return false;
    }

    function isSafeSingleCharPossessiveHead(text, nounCandidate) {
        var nounZh = text.substring(nounCandidate.start, nounCandidate.end);
        if (nounZh.length !== 1) return true;
        var next = text[nounCandidate.end] || '';
        if (!next || !isCJK(next) || isClauseBoundaryChar(next)) return true;
        return /^(?:很|甚|极|極|颇|頗|更|还|還|也|都|却|卻|便|就|才|仍|已|会|會|能|可|是|有|在|了|着|著|过|過)$/.test(next);
    }

    function ownerSourceWithoutDe(text, ownerCandidate) {
        var source = text.substring(ownerCandidate.start, ownerCandidate.end);
        if (source[source.length - 1] === '的') source = source.substring(0, source.length - 1);
        return source;
    }

    function isPersonAppositionHead(text, nounCandidate) {
        var source = text.substring(nounCandidate.start, nounCandidate.end);
        return /^(?:人|女子|男子|女人|男人|女孩|男孩|姑娘|少年|少女|傻子|家伙|家夥|小子|丫头|丫頭|护卫|護衛|侍女|弟子|角色|人物)$/.test(source);
    }

    function hasNamingAppositionCueBefore(text, ownerCandidate, nounCandidate) {
        var prefix = text.substring(Math.max(0, ownerCandidate.start - 4), ownerCandidate.start);
        if (/(?:名叫|叫做|叫作|名为|名為|号称|號稱|称为|稱為|唤作|喚作)$/.test(prefix)) return true;
        return /叫$/.test(prefix) && isPersonAppositionHead(text, nounCandidate);
    }

    function isLocativePossessiveOwner(text, ownerCandidate) {
        var source = ownerSourceWithoutDe(text, ownerCandidate);
        return source === '中' || /(?:其中|当中|當中|里面|裡面|裏面|之中)$/.test(source);
    }

    function hasRelativeVerbObjectCueBefore(text, ownerCandidate, nounCandidate) {
        if (!isPersonAppositionHead(text, nounCandidate)) return false;
        var prefix = text.substring(Math.max(0, ownerCandidate.start - 4), ownerCandidate.start);
        return /(?:追求|喜欢|喜歡|扮演|饰演|飾演|演|穿|有|用|拿|带|帶)$/.test(prefix);
    }

    function shouldSkipPossessiveBridge(text, ownerCandidate, nounCandidate) {
        if (hasNamingAppositionCueBefore(text, ownerCandidate, nounCandidate)) return true;
        if (isLocativePossessiveOwner(text, ownerCandidate)) return true;
        if (hasRelativeVerbObjectCueBefore(text, ownerCandidate, nounCandidate)) return true;
        return false;
    }

    function buildPossessiveBridgeCandidate(text, ownerCandidate, nounCandidate, modifierCandidate) {
        var possessor = possessiveValueForCandidate(ownerCandidate);
        if (!possessor && isStrongPossessorCandidate(ownerCandidate)) {
            var ownerValue = ((ownerCandidate.value || '').trim()).replace(/\s+của$/i, '').trim();
            if (ownerValue) possessor = 'của ' + ownerValue;
        }
        if (!possessor || !nounCandidate || nounCandidate.type !== 'exact' || !looksLikeNominalValue(nounCandidate.value)) return null;
        if (shouldSkipPossessiveBridge(text, ownerCandidate, nounCandidate)) return null;
        if (!isSafeSingleCharPossessiveHead(text, nounCandidate)) return null;
        var modifierValue = modifierCandidate ? ((modifierCandidate.value || '').trim()) : '';
        var headValue = ((nounCandidate.value || '').trim() + (modifierValue ? ' ' + modifierValue : '')).replace(/ {2,}/g, ' ').trim();
        var value = (headValue + ' ' + possessor).replace(/ {2,}/g, ' ').trim();
        var modifierScore = modifierCandidate ? (modifierCandidate.score || 0) : 0;
        return {
            type: 'possessive-bridge',
            start: ownerCandidate.start,
            end: nounCandidate.end,
            len: nounCandidate.end - ownerCandidate.start,
            value: value,
            pri: Math.max(ownerCandidate.pri | 0, nounCandidate.pri | 0),
            score: ownerCandidate.score + modifierScore + nounCandidate.score + 22,
            compareLen: nounCandidate.end - ownerCandidate.start,
            tokenCountInc: 1,
            fallbackCountInc: (ownerCandidate.fallbackCountInc || 0) + (modifierCandidate ? (modifierCandidate.fallbackCountInc || 0) : 0) + (nounCandidate.fallbackCountInc || 0),
            rawCountInc: (ownerCandidate.rawCountInc || 0) + (modifierCandidate ? (modifierCandidate.rawCountInc || 0) : 0) + (nounCandidate.rawCountInc || 0),
            exactCharsInc: (ownerCandidate.exactCharsInc || 0) + (modifierCandidate ? (modifierCandidate.exactCharsInc || 0) : 0) + (nounCandidate.exactCharsInc || 0),
            strongExactCountInc: (ownerCandidate.strongExactCountInc || 0) + (modifierCandidate ? (modifierCandidate.strongExactCountInc || 0) : 0) + (nounCandidate.strongExactCountInc || 0),
            singleCountInc: 0
        };
    }

    function buildVerbRelativeBridgeCandidate(text, verbCandidate, nounCandidate, particleScore) {
        if (!isAttributiveVerbCandidate(text, verbCandidate)) return null;
        if (!isVerbRelativeHeadCandidate(text, nounCandidate)) return null;
        if (!isSafeSingleCharPossessiveHead(text, nounCandidate)) return null;
        var verbValue = ((verbCandidate.value || '') + '').trim();
        var nounValue = ((nounCandidate.value || '') + '').trim();
        if (!verbValue || !nounValue) return null;
        return {
            type: 'verb-relative-bridge',
            start: verbCandidate.start,
            end: nounCandidate.end,
            len: nounCandidate.end - verbCandidate.start,
            value: (nounValue + ' ' + verbValue).replace(/ {2,}/g, ' ').trim(),
            pri: Math.max(verbCandidate.pri | 0, nounCandidate.pri | 0),
            score: verbCandidate.score + (particleScore || 0) + nounCandidate.score + 48,
            compareLen: nounCandidate.end - verbCandidate.start,
            tokenCountInc: 1,
            fallbackCountInc: (verbCandidate.fallbackCountInc || 0) + (nounCandidate.fallbackCountInc || 0),
            rawCountInc: (verbCandidate.rawCountInc || 0) + (nounCandidate.rawCountInc || 0),
            exactCharsInc: (verbCandidate.exactCharsInc || 0) + (nounCandidate.exactCharsInc || 0),
            strongExactCountInc: (verbCandidate.strongExactCountInc || 0) + (nounCandidate.strongExactCountInc || 0),
            singleCountInc: 0
        };
    }

    function buildAttributiveModifierBridgeCandidate(text, modifierCandidate, nounCandidate, particleScore) {
        if (!isAttributiveAdjectiveCandidate(text, modifierCandidate)) return null;
        if (!isAttributiveModifierHeadCandidate(text, nounCandidate)) return null;
        if (!isSafeSingleCharPossessiveHead(text, nounCandidate)) return null;
        var modifierValue = ((modifierCandidate.value || '') + '').trim();
        var nounValue = ((nounCandidate.value || '') + '').trim();
        if (!modifierValue || !nounValue) return null;
        return {
            type: 'attributive-modifier-bridge',
            start: modifierCandidate.start,
            end: nounCandidate.end,
            len: nounCandidate.end - modifierCandidate.start,
            value: (nounValue + ' ' + modifierValue).replace(/ {2,}/g, ' ').trim(),
            pri: Math.max(modifierCandidate.pri | 0, nounCandidate.pri | 0),
            score: modifierCandidate.score + (particleScore || 0) + nounCandidate.score + 22,
            compareLen: nounCandidate.end - modifierCandidate.start,
            tokenCountInc: 1,
            fallbackCountInc: (modifierCandidate.fallbackCountInc || 0) + (nounCandidate.fallbackCountInc || 0),
            rawCountInc: (modifierCandidate.rawCountInc || 0) + (nounCandidate.rawCountInc || 0),
            exactCharsInc: (modifierCandidate.exactCharsInc || 0) + (nounCandidate.exactCharsInc || 0),
            strongExactCountInc: (modifierCandidate.strongExactCountInc || 0) + (nounCandidate.strongExactCountInc || 0),
            singleCountInc: 0
        };
    }

    function comparativeMarkerEnd(text, pos) {
        if (text.substring(pos, pos + 2) === '更加' || text.substring(pos, pos + 2) === '更为' || text.substring(pos, pos + 2) === '更為') return pos + 2;
        if (text[pos] === '更' || text[pos] === '还' || text[pos] === '還') return pos + 1;
        return pos;
    }

    function isShortComparativeAdjectiveSource(zh) {
        return /^(?:高|低|快|慢|强|強|弱|大|小|好|差|多|少|早|晚|长|長|短|远|遠|近|重|轻|輕|难|難|易|贵|貴)$/.test(zh || '');
    }

    function isAllowedSingleCharComparativeSubject(zh) {
        return startsWithPronounSource(zh) || /^(?:也|都|又|还|還|兜)$/.test(zh || '');
    }

    function buildComparativeBridgeCandidate(text, subjectCandidate, objectCandidate, adjectiveCandidate, markerStart, adjectiveStart) {
        if (!subjectCandidate || !objectCandidate || !adjectiveCandidate) return null;
        if (subjectCandidate.type !== 'exact' || objectCandidate.type !== 'exact' || adjectiveCandidate.type !== 'exact') return null;
        var subjectZh = text.substring(subjectCandidate.start, subjectCandidate.end);
        var objectZh = text.substring(objectCandidate.start, objectCandidate.end);
        if (isNumericCapture(subjectZh) || isNumericCapture(objectZh)) return null;
        if (subjectZh.length === 1 && !isAllowedSingleCharComparativeSubject(subjectZh)) return null;
        var subject = ((subjectCandidate.value || '').trim());
        var object = ((objectCandidate.value || '').trim());
        var adjective = ((adjectiveCandidate.value || '').trim());
        if (!subject || !object || !adjective) return null;
        if (looksLikeVerbishValue(adjective) || looksLikeNominalValue(adjective)) return null;
        if (markerStart === adjectiveStart && !isShortComparativeAdjectiveSource(text.substring(adjectiveCandidate.start, adjectiveCandidate.end))) return null;
        var value = (subject + ' ' + adjective + ' hơn ' + object).replace(/ {2,}/g, ' ').trim();
        return {
            type: 'comparative-bridge',
            start: subjectCandidate.start,
            end: adjectiveCandidate.end,
            len: adjectiveCandidate.end - subjectCandidate.start,
            value: value,
            pri: Math.max(subjectCandidate.pri | 0, objectCandidate.pri | 0, adjectiveCandidate.pri | 0),
            score: subjectCandidate.score + objectCandidate.score + adjectiveCandidate.score + 30,
            compareLen: adjectiveCandidate.end - subjectCandidate.start,
            tokenCountInc: 1,
            fallbackCountInc: (subjectCandidate.fallbackCountInc || 0) + (objectCandidate.fallbackCountInc || 0) + (adjectiveCandidate.fallbackCountInc || 0),
            rawCountInc: (subjectCandidate.rawCountInc || 0) + (objectCandidate.rawCountInc || 0) + (adjectiveCandidate.rawCountInc || 0),
            exactCharsInc: (subjectCandidate.exactCharsInc || 0) + (objectCandidate.exactCharsInc || 0) + (adjectiveCandidate.exactCharsInc || 0),
            strongExactCountInc: (subjectCandidate.strongExactCountInc || 0) + (objectCandidate.strongExactCountInc || 0) + (adjectiveCandidate.strongExactCountInc || 0),
            singleCountInc: 0
        };
    }

    function complementDegreeMarker(text, pos) {
        var map = {
            '那么': 'như vậy',
            '那麼': 'như vậy',
            '那幺': 'như vậy',
            '这么': 'như vậy',
            '這麼': 'như vậy',
            '这幺': 'như vậy',
            '不够': 'không đủ',
            '不夠': 'không đủ',
            '非常': 'vô cùng',
            '特别': 'đặc biệt',
            '特別': 'đặc biệt',
            '十分': 'mười phần',
            '太过': 'quá mức',
            '太過': 'quá mức',
            '相当': 'tương đối',
            '相當': 'tương đối',
            '格外': 'đặc biệt',
            '异常': 'dị thường',
            '異常': 'dị thường'
        };
        var two = text.substring(pos, pos + 2);
        if (map[two]) return { end: pos + 2, value: map[two] };
        var one = text[pos];
        if (one === '更') return { end: pos + 1, value: 'càng' };
        if (one === '还' || one === '還') return { end: pos + 1, value: 'còn' };
        if (one === '真') return { end: pos + 1, value: 'thật' };
        if (one === '太') return { end: pos + 1, value: 'quá' };
        if (one === '很') return { end: pos + 1, value: 'rất' };
        if (one === '挺') return { end: pos + 1, value: 'khá' };
        if (one === '颇' || one === '頗') return { end: pos + 1, value: 'khá' };
        return null;
    }

    function extendRepeatedComplementDegreeMarker(text, marker) {
        var current = marker;
        for (var i = 0; i < 2 && current; i++) {
            var next = complementDegreeMarker(text, current.end);
            if (!next) break;
            current = {
                end: next.end,
                value: (current.value + ' ' + next.value).replace(/ {2,}/g, ' ').trim()
            };
        }
        return current;
    }

    function stripGenericDeSuffix(value) {
        var trimmed = ((value || '') + '').trim();
        var stripped = trimmed.replace(/\s+(?:đến|đến|được|đắc|tới|tới)$/i, '').trim();
        return stripped && stripped !== trimmed ? stripped : '';
    }

    function hasBlockingDeExactEndingAt(searchState, start, endLimit, end) {
        var matches = collectExactCandidates(searchState, start, endLimit);
        for (var i = 0; i < matches.length; i++) {
            if (matches[i].end !== end) continue;
            var value = ((matches[i].value || '').trim());
            if (!/^(?:đến|đến|được|đắc|tới|tới)\b/i.test(value) && !stripGenericDeSuffix(value)) return true;
        }
        return false;
    }

    function isComplementVerbCandidate(text, candidate) {
        if (!candidate || candidate.type !== 'exact') return false;
        var zh = text.substring(candidate.start, candidate.end);
        var value = ((candidate.value || '').trim());
        if (!zh || !value) return false;
        if (zh === '来' || zh === '來') return false;
        if (looksLikeNominalValue(value)) return false;
        if (COMPLEMENT_VERB_SOURCE_RE.test(zh)) return true;
        return zh.length <= 2 && looksLikeVerbishValue(value);
    }

    function isComplementAdjectiveCandidate(candidate) {
        if (!candidate || candidate.type !== 'exact') return false;
        var value = ((candidate.value || '').trim());
        if (!value) return false;
        if (looksLikeNominalValue(value) || looksLikeVerbishValue(value)) return false;
        if (/^(?:của|cho|với|tại|ở|trong|trên|đến|được|đắc)\b/i.test(value)) return false;
        return (candidate.len | 0) <= 4;
    }

    function buildDegreeComplementBridgeCandidate(searchState, verbCandidate, adjectiveCandidate, marker) {
        if (!isComplementVerbCandidate(searchState.text, verbCandidate) || !isComplementAdjectiveCandidate(adjectiveCandidate) || !marker) return null;
        var verb = ((verbCandidate.value || '').trim());
        var adjective = ((adjectiveCandidate.value || '').trim());
        var value = (verb + ' ' + marker.value + ' ' + adjective).replace(/ {2,}/g, ' ').trim();
        return {
            type: 'degree-complement-bridge',
            start: verbCandidate.start,
            end: adjectiveCandidate.end,
            len: adjectiveCandidate.end - verbCandidate.start,
            value: value,
            pri: Math.max(verbCandidate.pri | 0, adjectiveCandidate.pri | 0),
            score: verbCandidate.score + adjectiveCandidate.score + 260 + Math.min(24, (marker.end - verbCandidate.end) * 4),
            compareLen: adjectiveCandidate.end - verbCandidate.start,
            tokenCountInc: 1,
            fallbackCountInc: (verbCandidate.fallbackCountInc || 0) + (adjectiveCandidate.fallbackCountInc || 0),
            rawCountInc: (verbCandidate.rawCountInc || 0) + (adjectiveCandidate.rawCountInc || 0),
            exactCharsInc: (verbCandidate.exactCharsInc || 0) + (adjectiveCandidate.exactCharsInc || 0),
            strongExactCountInc: (verbCandidate.strongExactCountInc || 0) + (adjectiveCandidate.strongExactCountInc || 0),
            singleCountInc: 0
        };
    }

    function isDisposalSubjectCandidate(text, candidate) {
        if (!candidate || candidate.type !== 'exact') return false;
        var zh = text.substring(candidate.start, candidate.end);
        var value = ((candidate.value || '').trim());
        if (!zh || !value || looksLikeVerbishValue(value)) return false;
        if (startsWithPronounSource(zh) || isStrongPossessorCandidate(candidate)) return true;
        if (looksLikeNominalValue(value)) return true;
        return zh.length >= 2 && VI_UPPER_START_RE.test(value);
    }

    function isDisposalObjectCandidate(text, candidate) {
        if (!candidate || candidate.type !== 'exact') return false;
        var zh = text.substring(candidate.start, candidate.end);
        var value = ((candidate.value || '').trim());
        if (!zh || !value || looksLikeVerbishValue(value)) return false;
        if (/^(?:của|cho|với|tại|ở|trong|trên|đến|được|đắc|thì|là)\b/i.test(value)) return false;
        if (/^(?:人|事|物|宝|寶|钱|錢|门|門|刀|剑|劍|纸|紙|信)$/.test(zh)) return true;
        if (startsWithPronounSource(zh) || looksLikeNominalValue(value)) return true;
        return zh.length >= 2 && !/^(?:rất|khá|càng|lại|liền|đã|sẽ|đang)\b/i.test(value);
    }

    function isDisposalVerbCandidate(text, candidate) {
        if (!candidate || candidate.type !== 'exact') return false;
        var zh = text.substring(candidate.start, candidate.end);
        var value = ((candidate.value || '').trim());
        if (!zh || !value || !DISPOSAL_VERB_SOURCE_RE.test(zh)) return false;
        if (/^(?:coi|xem|cho rằng|nghĩ|biết|cảm thấy)\b/i.test(value)) return false;
        return /^(?:đưa|mang|ném|quăng|vứt|giao|trả|dẫn|dắt|cầm|lấy|rút|đặt|để|thả|buông|kéo|đẩy|mở|đóng|thu|cất|chuyển|dời|dọn|khiêng|bưng)(?:\s|$)/i.test(value);
    }

    function buildDisposalBridgeCandidate(text, subjectCandidate, objectCandidate, verbCandidate) {
        if (!isDisposalSubjectCandidate(text, subjectCandidate) || !isDisposalObjectCandidate(text, objectCandidate) || !isDisposalVerbCandidate(text, verbCandidate)) return null;
        var subject = ((subjectCandidate.value || '').trim());
        var object = ((objectCandidate.value || '').trim());
        var verb = ((verbCandidate.value || '').trim());
        var value = (subject + ' ' + verb + ' ' + object).replace(/ {2,}/g, ' ').trim();
        return {
            type: 'disposal-bridge',
            start: subjectCandidate.start,
            end: verbCandidate.end,
            len: verbCandidate.end - subjectCandidate.start,
            value: value,
            pri: Math.max(subjectCandidate.pri | 0, objectCandidate.pri | 0, verbCandidate.pri | 0),
            score: subjectCandidate.score + objectCandidate.score + verbCandidate.score + 82,
            compareLen: verbCandidate.end - subjectCandidate.start,
            tokenCountInc: 1,
            fallbackCountInc: (subjectCandidate.fallbackCountInc || 0) + (objectCandidate.fallbackCountInc || 0) + (verbCandidate.fallbackCountInc || 0),
            rawCountInc: (subjectCandidate.rawCountInc || 0) + (objectCandidate.rawCountInc || 0) + (verbCandidate.rawCountInc || 0),
            exactCharsInc: (subjectCandidate.exactCharsInc || 0) + (objectCandidate.exactCharsInc || 0) + (verbCandidate.exactCharsInc || 0),
            strongExactCountInc: (subjectCandidate.strongExactCountInc || 0) + (objectCandidate.strongExactCountInc || 0) + (verbCandidate.strongExactCountInc || 0),
            singleCountInc: 0
        };
    }

    function passiveAgentValueForCandidate(text, candidate) {
        if (!candidate || candidate.type !== 'exact') return '';
        var zh = text.substring(candidate.start, candidate.end);
        var value = ((candidate.value || '').trim());
        if (!zh || !value || looksLikeVerbishValue(value) || looksLikeNominalValue(value)) return '';
        if (startsWithPronounSource(zh) || VI_PRONOUN_START_RE.test(value) || isStrongPossessorCandidate(candidate)) return value;
        return '';
    }

    function isPassiveZheVerbCandidate(text, candidate) {
        if (!candidate || candidate.type !== 'exact') return false;
        var zh = text.substring(candidate.start, candidate.end);
        var value = ((candidate.value || '').trim());
        if (!zh || !value || PASSIVE_ZHE_SKIP_SOURCE_RE.test(zh)) return false;
        if (/^(?:người|kẻ|bị|được|của|cho|với|tại|ở|trong|trên)\b/i.test(value)) return false;
        if (looksLikeNominalValue(value)) return false;
        return zh.length <= 6;
    }

    function isPassiveZheBoundary(text, end) {
        var next = text[end] || '';
        return !next || next === '的' || /\s/.test(next) || isClauseBoundaryChar(next);
    }

    function buildPassiveZheBridgeCandidate(text, agentCandidate, verbCandidate) {
        if (!isPassiveZheVerbCandidate(text, verbCandidate)) return null;
        if (!isPassiveZheBoundary(text, verbCandidate.end + 1)) return null;
        var agent = passiveAgentValueForCandidate(text, agentCandidate);
        if (agentCandidate && !agent) return null;
        var verb = ((verbCandidate.value || '').trim());
        var value = ('người bị ' + (agent ? agent + ' ' : '') + verb).replace(/ {2,}/g, ' ').trim();
        return {
            type: 'passive-zhe-bridge',
            start: agentCandidate ? agentCandidate.start - 1 : verbCandidate.start - 1,
            end: verbCandidate.end + 1,
            len: verbCandidate.end + 1 - (agentCandidate ? agentCandidate.start - 1 : verbCandidate.start - 1),
            value: value,
            pri: Math.max(agentCandidate ? (agentCandidate.pri | 0) : 0, verbCandidate.pri | 0),
            score: (agentCandidate ? agentCandidate.score : 0) + verbCandidate.score + 96,
            compareLen: verbCandidate.end + 1 - (agentCandidate ? agentCandidate.start - 1 : verbCandidate.start - 1),
            tokenCountInc: 1,
            fallbackCountInc: (agentCandidate ? (agentCandidate.fallbackCountInc || 0) : 0) + (verbCandidate.fallbackCountInc || 0),
            rawCountInc: (agentCandidate ? (agentCandidate.rawCountInc || 0) : 0) + (verbCandidate.rawCountInc || 0),
            exactCharsInc: 2 + (agentCandidate ? (agentCandidate.exactCharsInc || 0) : 0) + (verbCandidate.exactCharsInc || 0),
            strongExactCountInc: (agentCandidate ? (agentCandidate.strongExactCountInc || 0) : 0) + (verbCandidate.strongExactCountInc || 0),
            singleCountInc: 0
        };
    }

    function buildPassiveZhePossessiveBridgeCandidate(passiveCandidate, nounCandidate) {
        if (!passiveCandidate || passiveCandidate.type !== 'passive-zhe-bridge' || !nounCandidate || nounCandidate.type !== 'exact') return null;
        if (!looksLikeNominalValue(nounCandidate.value) && ((nounCandidate.len | 0) < 2 || looksLikeVerbishValue(nounCandidate.value))) return null;
        var passive = ((passiveCandidate.value || '').trim());
        var noun = ((nounCandidate.value || '').trim());
        if (!passive || !noun) return null;
        var value = (noun + ' của ' + passive).replace(/ {2,}/g, ' ').trim();
        return {
            type: 'passive-zhe-possessive-bridge',
            start: passiveCandidate.start,
            end: nounCandidate.end,
            len: nounCandidate.end - passiveCandidate.start,
            value: value,
            pri: Math.max(passiveCandidate.pri | 0, nounCandidate.pri | 0),
            score: passiveCandidate.score + nounCandidate.score + 44,
            compareLen: nounCandidate.end - passiveCandidate.start,
            tokenCountInc: 1,
            fallbackCountInc: (passiveCandidate.fallbackCountInc || 0) + (nounCandidate.fallbackCountInc || 0),
            rawCountInc: (passiveCandidate.rawCountInc || 0) + (nounCandidate.rawCountInc || 0),
            exactCharsInc: (passiveCandidate.exactCharsInc || 0) + (nounCandidate.exactCharsInc || 0),
            strongExactCountInc: (passiveCandidate.strongExactCountInc || 0) + (nounCandidate.strongExactCountInc || 0),
            singleCountInc: 0
        };
    }

    function compareContextEntries(a, b) {
        if (b.len !== a.len) return b.len - a.len;
        if ((b.pri | 0) !== (a.pri | 0)) return (b.pri | 0) - (a.pri | 0);
        return (a.rank | 0) - (b.rank | 0);
    }

    function collectContextTrieEntries(text, pos, endLimit) {
        if (!root) return [];
        var node = root;
        var out = [];
        var j = pos;
        while (j < endLimit && node.c[text[j]]) {
            node = node.c[text[j]];
            j++;
            if (node.v !== null) {
                out.push({
                    start: pos,
                    end: j,
                    len: j - pos,
                    value: node.v,
                    pri: node.p | 0,
                    src: node.s || '',
                    key: node.k || text.substring(pos, j),
                    rank: 0
                });
                if (node.a) {
                    for (var ai = 0; ai < node.a.length; ai++) {
                        out.push({
                            start: pos,
                            end: j,
                            len: j - pos,
                            value: node.a[ai].v,
                            pri: node.a[ai].p | 0,
                            src: node.a[ai].s || '',
                            key: node.a[ai].k || text.substring(pos, j),
                            rank: ai + 1
                        });
                    }
                }
            }
        }
        out.sort(compareContextEntries);
        if (out.length > 8) out.length = 8;
        return out;
    }

    function findContextEntryByKind(text, pos, endLimit, matcher) {
        var entries = collectContextTrieEntries(text, pos, endLimit);
        for (var i = 0; i < entries.length; i++) {
            if (matcher(entries[i].value || '')) return entries[i];
        }
        return null;
    }

    function isDisposalMarkerContext(searchState, start, end) {
        var text = searchState.text;
        var marker = text.substring(start, end);
        if (marker !== '将' && marker !== '把') return false;
        if (end >= text.length || !isCJK(text[end])) return false;

        var objectEndLimit = Math.min(text.length, end + 8);
        var objectEntry = findContextEntryByKind(text, end, objectEndLimit, looksLikeNominalValue);
        if (!objectEntry) return false;

        var verbStart = objectEntry.end;
        if (verbStart >= text.length || !isCJK(text[verbStart])) return false;

        var verbEndLimit = Math.min(text.length, verbStart + 10);
        return !!findContextEntryByKind(text, verbStart, verbEndLimit, looksLikeVerbishValue);
    }

    function compareCandidates(a, b) {
        if (b.score !== a.score) return b.score - a.score;
        if (b.compareLen !== a.compareLen) return b.compareLen - a.compareLen;
        if (b.len !== a.len) return b.len - a.len;
        return (b.pri | 0) - (a.pri | 0);
    }

    function dedupeAndLimitCandidates(candidates, limit) {
        var bestByKey = Object.create(null);
        for (var i = 0; i < candidates.length; i++) {
            var cand = candidates[i];
            var key = cand.type + '|' + cand.start + '|' + cand.end + '|' + cand.value;
            if (!bestByKey[key] || compareCandidates(cand, bestByKey[key]) < 0) bestByKey[key] = cand;
        }
        var out = [];
        for (var key2 in bestByKey) out.push(bestByKey[key2]);
        out.sort(compareCandidates);
        if (out.length > limit) out.length = limit;
        return out;
    }

    function trieMatchWithin(text, pos, endLimit) {
        if (!root) return null;
        var node = root, lastMatch = -1, lastValue = null, lastPri = 0, j = pos;
        while (j < endLimit && node.c[text[j]]) {
            node = node.c[text[j]];
            j++;
            if (node.v !== null) {
                lastMatch = j;
                lastValue = node.v;
                lastPri = node.p;
            }
        }
        if (lastMatch > pos) return { end: lastMatch, value: lastValue, pri: lastPri };
        return null;
    }

    function collectOverlayCandidates(searchState, pos, endLimit) {
        var index = searchState.overlayIndex;
        var text = searchState.text;
        if (!index || !text[pos]) return [];
        var bucket = index[text[pos]];
        if (!bucket || !bucket.length) return [];
        var out = [];

        for (var i = 0; i < bucket.length; i++) {
            var entry = bucket[i];
            var end = pos + entry.zh.length;
            if (end > endLimit) continue;
            if (text.substring(pos, end) !== entry.zh) continue;
            out.push(buildExactCandidate(searchState, pos, end, entry));
        }
        return out;
    }

    function collectTrieCandidates(searchState, pos, endLimit) {
        if (!root) return [];
        var text = searchState.text;
        var node = root;
        var out = [];
        var j = pos;
        while (j < endLimit && node.c[text[j]]) {
            node = node.c[text[j]];
            j++;
            if (node.v !== null) {
                out.push(buildExactCandidate(searchState, pos, j, {
                    value: node.v,
                    pri: node.p,
                    src: node.s || '',
                    key: node.k || text.substring(pos, j),
                    rank: 0
                }));
                if (node.a) {
                    for (var ai = 0; ai < node.a.length; ai++) {
                        out.push(buildExactCandidate(searchState, pos, j, {
                            value: node.a[ai].v,
                            pri: node.a[ai].p,
                            src: node.a[ai].s || '',
                            key: node.a[ai].k || text.substring(pos, j),
                            rank: ai + 1
                        }));
                    }
                }
            }
        }
        return out;
    }

    function collectExactCandidates(searchState, pos, endLimit) {
        var out = collectTrieCandidates(searchState, pos, endLimit);
        var overlayCandidates = collectOverlayCandidates(searchState, pos, endLimit);
        for (var i = 0; i < overlayCandidates.length; i++) out.push(overlayCandidates[i]);
        return dedupeAndLimitCandidates(out, SEARCH_MAX_CANDIDATES);
    }

    function exactMatchWithin(searchState, pos, endLimit) {
        var matches = collectExactCandidates(searchState, pos, endLimit);
        var best = null;
        for (var i = 0; i < matches.length; i++) {
            var match = matches[i];
            if (!best || match.end > best.end || (match.end === best.end && compareCandidates(match, best) < 0)) {
                best = match;
            }
        }
        if (!best) return null;
        return { end: best.end, value: best.value, pri: best.pri };
    }

    function collectSuffixPatternMatches(text, pos, endLimit) {
        if (!patSuffixRoot) return [];
        var node = patSuffixRoot;
        var out = [];
        for (var s = pos; s < endLimit; s++) {
            if (!node.c[text[s]]) break;
            node = node.c[text[s]];
            if (!node.templates) continue;
            var suffLen = s - pos + 1;
            for (var ti = 0; ti < node.templates.length; ti++) {
                out.push({ len: suffLen, template: node.templates[ti] });
            }
        }
        return out;
    }

    function materializeSearchState(state) {
        if (!state) return makeEmptySearchResult();
        var parts = [];
        var cursor = state;
        while (cursor && cursor.candidate) {
            parts.push(cursor.candidate.value);
            cursor = cursor.prev;
        }
        parts.reverse();
        return {
            text: parts.join(' ').replace(/ {2,}/g, ' ').trim(),
            score: state.score,
            tokenCount: state.tokenCount,
            fallbackCount: state.fallbackCount,
            rawCount: state.rawCount,
            exactChars: state.exactChars,
            strongExactCount: state.strongExactCount,
            singleCount: state.singleCount
        };
    }

    function compareSearchStates(a, b) {
        var aRank = a.score + (a.pos * 0.5) - (a.tokenCount * 0.25);
        var bRank = b.score + (b.pos * 0.5) - (b.tokenCount * 0.25);
        if (bRank !== aRank) return bRank - aRank;
        if (b.score !== a.score) return b.score - a.score;
        if (b.pos !== a.pos) return b.pos - a.pos;
        if (a.fallbackCount !== b.fallbackCount) return a.fallbackCount - b.fallbackCount;
        return a.tokenCount - b.tokenCount;
    }

    function pruneSearchStates(states, beamWidth) {
        var byPos = Object.create(null);
        for (var i = 0; i < states.length; i++) {
            var state = states[i];
            var key = String(state.pos);
            if (!byPos[key]) byPos[key] = [];
            byPos[key].push(state);
        }
        var merged = [];
        for (var key2 in byPos) {
            byPos[key2].sort(compareSearchStates);
            if (byPos[key2].length > SEARCH_MAX_STATES_PER_POS) byPos[key2].length = SEARCH_MAX_STATES_PER_POS;
            for (var j = 0; j < byPos[key2].length; j++) merged.push(byPos[key2][j]);
        }
        merged.sort(compareSearchStates);
        if (merged.length > beamWidth) merged.length = beamWidth;
        return merged;
    }

    function advanceSearchState(prev, candidate) {
        var nextScore = prev.score + candidate.score;
        var nextFallbackStreak = (candidate.type === 'fallback' || candidate.type === 'raw-char') ? prev.fallbackStreak + 1 : 0;
        var nextSingleStreak = (candidate.type !== 'literal' && candidate.len === 1) ? prev.singleStreak + 1 : 0;
        if (nextFallbackStreak > 1) nextScore -= nextFallbackStreak * 10;
        if (nextSingleStreak > 1) nextScore -= (nextSingleStreak - 1) * 7;
        if (prev.lastType === 'pattern' && candidate.type === 'pattern') nextScore -= 6;
        return {
            pos: candidate.end,
            score: nextScore,
            tokenCount: prev.tokenCount + (candidate.tokenCountInc || 0),
            fallbackCount: prev.fallbackCount + (candidate.fallbackCountInc || 0),
            rawCount: prev.rawCount + (candidate.rawCountInc || 0),
            exactChars: prev.exactChars + (candidate.exactCharsInc || 0),
            strongExactCount: prev.strongExactCount + (candidate.strongExactCountInc || 0),
            singleCount: prev.singleCount + (candidate.singleCountInc || 0),
            fallbackStreak: nextFallbackStreak,
            singleStreak: nextSingleStreak,
            lastType: candidate.type,
            prev: prev,
            candidate: candidate
        };
    }

    function translateSpanWithSearch(searchState, start, end, allowPatterns) {
        if (start >= end) return makeEmptySearchResult();
        var cacheKey = start + ':' + end + ':' + (allowPatterns ? '1' : '0');
        if (searchState.subspanCache[cacheKey]) return searchState.subspanCache[cacheKey];

        var frontier = [{
            pos: start,
            score: 0,
            tokenCount: 0,
            fallbackCount: 0,
            rawCount: 0,
            exactChars: 0,
            strongExactCount: 0,
            singleCount: 0,
            fallbackStreak: 0,
            singleStreak: 0,
            lastType: '',
            prev: null,
            candidate: null
        }];
        var finished = [];
        var beamWidth = allowPatterns ? SEARCH_BEAM_WIDTH : CAPTURE_BEAM_WIDTH;

        while (frontier.length) {
            var expanded = [];
            for (var i = 0; i < frontier.length; i++) {
                var state = frontier[i];
                if (state.pos >= end) {
                    finished.push(state);
                    continue;
                }
                var candidates = collectCandidatesAt(searchState, state.pos, end, allowPatterns);
                for (var j = 0; j < candidates.length; j++) {
                    expanded.push(advanceSearchState(state, candidates[j]));
                }
            }
            if (!expanded.length) break;
            frontier = pruneSearchStates(expanded, beamWidth);
        }

        var pool = finished.length ? finished : frontier;
        pool.sort(compareSearchStates);
        var result = pool.length ? materializeSearchState(pool[0]) : makeEmptySearchResult();
        searchState.subspanCache[cacheKey] = result;
        return result;
    }

    function collectPrefixPatternCandidates(searchState, pos, endLimit) {
        if (!patPrefixRoot) return [];
        var text = searchState.text;
        var node = patPrefixRoot;
        var out = [];
        var leadingTrie = collectExactCandidates(searchState, pos, endLimit);
        var leadingLongestEnd = -1;
        for (var lt = 0; lt < leadingTrie.length; lt++) {
            if (leadingTrie[lt].end > leadingLongestEnd) leadingLongestEnd = leadingTrie[lt].end;
        }

        for (var p = pos; p < endLimit; p++) {
            if (!node.c[text[p]]) break;
            node = node.c[text[p]];
            if (!node.patterns) continue;
                var prefixLen = p - pos + 1;
                var captureStart = pos + prefixLen;
                var prefixText = text.substring(pos, captureStart);
                for (var pi = 0; pi < node.patterns.length; pi++) {
                    var pat = node.patterns[pi];
                    if (captureStart >= endLimit) continue;
                    if (pat.suffix.length === 0) {
                        var captureMatches = collectExactCandidates(searchState, captureStart, endLimit);
                        captureMatches.sort(compareCandidates);
                        if (captureMatches.length > CAPTURE_MAX_CANDIDATES) captureMatches.length = CAPTURE_MAX_CANDIDATES;
                        for (var ci = 0; ci < captureMatches.length; ci++) {
                        var captureCandidate = captureMatches[ci];
                        var capText = text.substring(captureStart, captureCandidate.end);
                        if (!isPatternCaptureAllowed(capText, captureCandidate.pri, prefixText, '')) continue;
                        var overlapPenalty = (leadingLongestEnd > captureStart && leadingLongestEnd <= captureCandidate.end) ? 26 : 0;
                        out.push(buildPatternCandidate(
                            text,
                            pos,
                            captureCandidate.end,
                            pat.template,
                            prefixLen,
                            0,
                            capText,
                            captureInfoFromCandidate(captureCandidate),
                            overlapPenalty,
                            'pattern-prefix'
                        ));
                    }
                } else {
                    var suffLen = pat.suffix.length;
                    var maxCap = Math.min(captureStart + 30, endLimit - suffLen);
                    var matchCount = 0;
                    for (var cs = captureStart + 1; cs <= maxCap; cs++) {
                        var suffMatch = true;
                        for (var si = 0; si < suffLen; si++) {
                            if (text[cs + si] !== pat.suffix[si]) { suffMatch = false; break; }
                        }
                        if (!suffMatch) continue;
                        var capText2 = text.substring(captureStart, cs);
                        var cm = exactMatchWithin(searchState, captureStart, cs);
                        var capPri = cm ? cm.pri : 0;
                        if (!isPatternCaptureAllowed(capText2, capPri, prefixText, pat.suffix)) continue;
                        var captureInfo = translateSpanWithSearch(searchState, captureStart, cs, false);
                        var overlapPenalty2 = (leadingLongestEnd > captureStart && leadingLongestEnd <= cs + suffLen) ? 26 : 0;
                        out.push(buildPatternCandidate(
                            text,
                            pos,
                            cs + suffLen,
                            pat.template,
                            prefixLen,
                            suffLen,
                            capText2,
                            captureInfo,
                            overlapPenalty2,
                            'pattern-prefix-suffix'
                        ));
                        matchCount++;
                        if (matchCount >= 3) break;
                    }
                }
            }
        }
        return out;
    }

    function collectSuffixPatternCandidates(searchState, pos, endLimit, baseCandidate) {
        if (!patSuffixRoot || !baseCandidate || baseCandidate.end >= endLimit) return [];
        var text = searchState.text;
        var captureText = text.substring(pos, baseCandidate.end);
        var suffixMatches = collectSuffixPatternMatches(text, baseCandidate.end, endLimit);
        var out = [];
        for (var i = 0; i < suffixMatches.length; i++) {
            if (suffixMatches[i].len < 2) continue;
            var suffixText = text.substring(baseCandidate.end, baseCandidate.end + suffixMatches[i].len);
            if (!isPatternCaptureAllowed(captureText, baseCandidate.pri || 0, '', suffixText)) continue;
            out.push(buildPatternCandidate(
                text,
                pos,
                baseCandidate.end + suffixMatches[i].len,
                suffixMatches[i].template,
                0,
                suffixMatches[i].len,
                captureText,
                captureInfoFromCandidate(baseCandidate),
                0,
                'pattern-suffix'
            ));
        }
        return out;
    }

    function collectCandidatesAt(searchState, pos, endLimit, allowPatterns) {
        var cacheKey = pos + ':' + endLimit + ':' + (allowPatterns ? '1' : '0');
        if (searchState.candidateCache[cacheKey]) return searchState.candidateCache[cacheKey];
        var text = searchState.text;
        var candidates = [];

        if (!isCJK(text[pos])) {
            var literalEnd = pos + 1;
            while (literalEnd < endLimit && !isCJK(text[literalEnd])) literalEnd++;
            candidates.push(buildLiteralCandidate(text, pos, literalEnd));
            searchState.candidateCache[cacheKey] = candidates;
            return candidates;
        }

        var exactCandidates = collectExactCandidates(searchState, pos, endLimit);
        for (var i = 0; i < exactCandidates.length; i++) candidates.push(exactCandidates[i]);

        var runtimeNameCandidate = buildRuntimeNameDetectCandidate(searchState, pos, endLimit, exactCandidates);
        if (runtimeNameCandidate) candidates.push(runtimeNameCandidate);
        var kinshipAliasCandidate = buildKinshipAliasCandidate(searchState, pos, endLimit, exactCandidates);
        if (kinshipAliasCandidate) candidates.push(kinshipAliasCandidate);

        for (var eb = 0; eb < exactCandidates.length; eb++) {
            var ownerCandidate = exactCandidates[eb];
            var ownerZh = text.substring(ownerCandidate.start, ownerCandidate.end);
            if (!ownerZh) continue;
            var ownerForBridge = ownerCandidate;
            var nounStart = ownerCandidate.end;
            if (ownerZh[ownerZh.length - 1] === '的') {
                if (!isPronounPossessiveSource(ownerZh) && !isStrongPossessorCandidate(ownerCandidate)) continue;
            } else if ((isStrongPossessorCandidate(ownerCandidate) || possessiveValueForCandidate(ownerCandidate)) && text[ownerCandidate.end] === '的') {
                nounStart = ownerCandidate.end + 1;
                ownerForBridge = {
                    type: ownerCandidate.type,
                    start: ownerCandidate.start,
                    end: nounStart,
                    len: nounStart - ownerCandidate.start,
                    value: ownerCandidate.value,
                    pri: ownerCandidate.pri,
                    score: ownerCandidate.score + (particleSkipScore(searchState, ownerCandidate.end) || 0),
                    compareLen: nounStart - ownerCandidate.start,
                    tokenCountInc: ownerCandidate.tokenCountInc,
                    fallbackCountInc: ownerCandidate.fallbackCountInc,
                    rawCountInc: ownerCandidate.rawCountInc,
                    exactCharsInc: ownerCandidate.exactCharsInc,
                    strongExactCountInc: ownerCandidate.strongExactCountInc,
                    singleCountInc: ownerCandidate.singleCountInc,
                    source: ownerCandidate.source,
                    key: ownerCandidate.key,
                    overlayKind: ownerCandidate.overlayKind
                };
            } else {
                continue;
            }
            if (nounStart >= endLimit) continue;
            var nextExactCandidates = collectExactCandidates(searchState, nounStart, endLimit);
            nextExactCandidates.sort(compareCandidates);
            if (nextExactCandidates.length > 3) nextExactCandidates.length = 3;
            for (var ne = 0; ne < nextExactCandidates.length; ne++) {
                var bridged = buildPossessiveBridgeCandidate(text, ownerForBridge, nextExactCandidates[ne]);
                if (bridged) candidates.push(bridged);
                if (!isPossessiveModifierCandidate(nextExactCandidates[ne])) continue;
                var headExactCandidates = collectExactCandidates(searchState, nextExactCandidates[ne].end, endLimit);
                headExactCandidates.sort(compareCandidates);
                if (headExactCandidates.length > 3) headExactCandidates.length = 3;
                for (var he = 0; he < headExactCandidates.length; he++) {
                    var modifiedBridge = buildPossessiveBridgeCandidate(text, ownerForBridge, headExactCandidates[he], nextExactCandidates[ne]);
                    if (modifiedBridge) candidates.push(modifiedBridge);
                }
            }
        }

        for (var am = 0; am < exactCandidates.length; am++) {
            var modifierCandidate = exactCandidates[am];
            var modifierDePos = modifierCandidate.end;
            var modifierForBridge = modifierCandidate;
            var embeddedModifierDePos = text.substring(modifierCandidate.start, modifierCandidate.end).indexOf('的');
            if (embeddedModifierDePos > 0 && modifierCandidate.start + embeddedModifierDePos < modifierCandidate.end - 1) {
                var embeddedDePos = modifierCandidate.start + embeddedModifierDePos;
                var embeddedVerbCandidates = collectExactCandidates(searchState, modifierCandidate.start, embeddedDePos);
                embeddedVerbCandidates.sort(compareCandidates);
                if (embeddedVerbCandidates.length > 3) embeddedVerbCandidates.length = 3;
                var embeddedHeads = collectExactCandidates(searchState, embeddedDePos + 1, modifierCandidate.end);
                embeddedHeads.sort(compareCandidates);
                if (embeddedHeads.length > 3) embeddedHeads.length = 3;
                var embeddedParticleScore = particleSkipScore(searchState, embeddedDePos) || 0;
                for (var ev = 0; ev < embeddedVerbCandidates.length; ev++) {
                    if (embeddedVerbCandidates[ev].end !== embeddedDePos) continue;
                    if (!isAttributiveVerbCandidate(text, embeddedVerbCandidates[ev])) continue;
                    for (var eh = 0; eh < embeddedHeads.length; eh++) {
                        if (embeddedHeads[eh].end !== modifierCandidate.end) continue;
                        var embeddedVerbBridge = buildVerbRelativeBridgeCandidate(text, embeddedVerbCandidates[ev], embeddedHeads[eh], embeddedParticleScore);
                        if (embeddedVerbBridge) candidates.push(embeddedVerbBridge);
                    }
                }
            }
            if (text[modifierDePos] !== '的') {
                if (text[modifierDePos - 1] !== '的') continue;
                modifierDePos = modifierCandidate.end - 1;
                modifierForBridge = {
                    type: modifierCandidate.type,
                    start: modifierCandidate.start,
                    end: modifierDePos,
                    len: modifierDePos - modifierCandidate.start,
                    value: modifierCandidate.value,
                    pri: modifierCandidate.pri,
                    score: modifierCandidate.score,
                    compareLen: modifierDePos - modifierCandidate.start,
                    tokenCountInc: modifierCandidate.tokenCountInc,
                    fallbackCountInc: modifierCandidate.fallbackCountInc,
                    rawCountInc: modifierCandidate.rawCountInc,
                    exactCharsInc: modifierCandidate.exactCharsInc,
                    strongExactCountInc: modifierCandidate.strongExactCountInc,
                    singleCountInc: modifierCandidate.singleCountInc,
                    source: modifierCandidate.source,
                    key: modifierCandidate.key,
                    overlayKind: modifierCandidate.overlayKind
                };
            }
            var isAdjectiveModifier = isAttributiveAdjectiveCandidate(text, modifierForBridge);
            var isVerbModifier = !isAdjectiveModifier && isAttributiveVerbCandidate(text, modifierForBridge);
            if (!isAdjectiveModifier && !isVerbModifier) continue;
            if (isAdjectiveModifier && hasExactCandidateCrossingParticle(exactCandidates, modifierDePos)) continue;
            var modifierHeads = collectExactCandidates(searchState, modifierDePos + 1, endLimit);
            modifierHeads.sort(compareCandidates);
            if (modifierHeads.length > 3) modifierHeads.length = 3;
            var modifierParticleScore = particleSkipScore(searchState, modifierDePos) || 0;
            for (var mh = 0; mh < modifierHeads.length; mh++) {
                var modifierBridge = isAdjectiveModifier
                    ? buildAttributiveModifierBridgeCandidate(text, modifierForBridge, modifierHeads[mh], modifierParticleScore)
                    : buildVerbRelativeBridgeCandidate(text, modifierForBridge, modifierHeads[mh], modifierParticleScore);
                if (modifierBridge) candidates.push(modifierBridge);
            }
        }

        for (var cb = 0; cb < exactCandidates.length; cb++) {
            var subjectCandidate = exactCandidates[cb];
            var comparePos = subjectCandidate.end;
            if (text[comparePos] !== '比' || text[comparePos + 1] === '较' || text[comparePos + 1] === '較' || text[comparePos + 1] === '起' || text[comparePos + 1] === '试' || text[comparePos + 1] === '試') continue;
            var objectCandidates = collectExactCandidates(searchState, comparePos + 1, endLimit);
            objectCandidates.sort(compareCandidates);
            if (objectCandidates.length > 3) objectCandidates.length = 3;
            for (var oc = 0; oc < objectCandidates.length; oc++) {
                var markerStart = objectCandidates[oc].end;
                var adjectiveStart = comparativeMarkerEnd(text, markerStart);
                if (adjectiveStart >= endLimit) continue;
                var adjectiveCandidates = collectExactCandidates(searchState, adjectiveStart, endLimit);
                adjectiveCandidates.sort(compareCandidates);
                if (adjectiveCandidates.length > 3) adjectiveCandidates.length = 3;
                for (var ac = 0; ac < adjectiveCandidates.length; ac++) {
                    var comparative = buildComparativeBridgeCandidate(text, subjectCandidate, objectCandidates[oc], adjectiveCandidates[ac], markerStart, adjectiveStart);
                    if (comparative) candidates.push(comparative);
                }
            }
        }

        for (var db = 0; db < exactCandidates.length; db++) {
            var verbCandidate = exactCandidates[db];
            var dePos = verbCandidate.end;
            var strippedDeValue = '';
            if (text[dePos - 1] === '得') {
                strippedDeValue = stripGenericDeSuffix(verbCandidate.value);
                if (!strippedDeValue) continue;
                dePos = verbCandidate.end - 1;
                verbCandidate = {
                    type: verbCandidate.type,
                    start: verbCandidate.start,
                    end: dePos,
                    len: dePos - verbCandidate.start,
                    value: strippedDeValue,
                    pri: verbCandidate.pri,
                    score: verbCandidate.score,
                    compareLen: dePos - verbCandidate.start,
                    tokenCountInc: verbCandidate.tokenCountInc,
                    fallbackCountInc: verbCandidate.fallbackCountInc,
                    rawCountInc: verbCandidate.rawCountInc,
                    exactCharsInc: Math.max(0, (verbCandidate.exactCharsInc || 0) - 1),
                    strongExactCountInc: verbCandidate.strongExactCountInc,
                    singleCountInc: verbCandidate.singleCountInc,
                    source: verbCandidate.source,
                    key: verbCandidate.key,
                    overlayKind: verbCandidate.overlayKind
                };
            }
            if (text[dePos] !== '得') continue;
            if (hasBlockingDeExactEndingAt(searchState, verbCandidate.start, endLimit, dePos + 1)) continue;
            var marker = complementDegreeMarker(text, dePos + 1);
            if (marker) marker = extendRepeatedComplementDegreeMarker(text, marker);
            if (!marker || marker.end >= endLimit) continue;
            var complementCandidates = collectExactCandidates(searchState, marker.end, endLimit);
            complementCandidates.sort(compareCandidates);
            if (complementCandidates.length > 3) complementCandidates.length = 3;
            for (var dc = 0; dc < complementCandidates.length; dc++) {
                var complement = buildDegreeComplementBridgeCandidate(searchState, verbCandidate, complementCandidates[dc], marker);
                if (complement) candidates.push(complement);
            }
        }

        for (var bb = 0; bb < exactCandidates.length; bb++) {
            var disposalSubject = exactCandidates[bb];
            var baPos = disposalSubject.end;
            if (text[baPos] !== '把') continue;
            if (!isDisposalSubjectCandidate(text, disposalSubject)) continue;
            var disposalObjects = collectExactCandidates(searchState, baPos + 1, endLimit);
            disposalObjects.sort(compareCandidates);
            if (disposalObjects.length > 4) disposalObjects.length = 4;
            for (var bo = 0; bo < disposalObjects.length; bo++) {
                if (!isDisposalObjectCandidate(text, disposalObjects[bo])) continue;
                var verbStart = disposalObjects[bo].end;
                if (text[verbStart] === '给' || text[verbStart] === '給') verbStart++;
                if (verbStart >= endLimit) continue;
                var disposalVerbs = collectExactCandidates(searchState, verbStart, endLimit);
                disposalVerbs.sort(compareCandidates);
                if (disposalVerbs.length > 4) disposalVerbs.length = 4;
                for (var bv = 0; bv < disposalVerbs.length; bv++) {
                    var disposal = buildDisposalBridgeCandidate(text, disposalSubject, disposalObjects[bo], disposalVerbs[bv]);
                    if (disposal) candidates.push(disposal);
                }
            }
        }

        if (text[pos] === '被') {
            var addPassiveZheCandidates = function (passiveCandidate) {
                if (!passiveCandidate) return;
                candidates.push(passiveCandidate);
                if (text[passiveCandidate.end] !== '的') return;
                var passiveHeads = collectExactCandidates(searchState, passiveCandidate.end + 1, endLimit);
                passiveHeads.sort(compareCandidates);
                if (passiveHeads.length > 3) passiveHeads.length = 3;
                for (var ph = 0; ph < passiveHeads.length; ph++) {
                    var passivePossessive = buildPassiveZhePossessiveBridgeCandidate(passiveCandidate, passiveHeads[ph]);
                    if (passivePossessive) candidates.push(passivePossessive);
                }
            };
            var passiveFirst = collectExactCandidates(searchState, pos + 1, endLimit);
            passiveFirst.sort(compareCandidates);
            if (passiveFirst.length > 4) passiveFirst.length = 4;
            for (var pz = 0; pz < passiveFirst.length; pz++) {
                if (text[passiveFirst[pz].end] === '者') {
                    var directPassive = buildPassiveZheBridgeCandidate(text, null, passiveFirst[pz]);
                    addPassiveZheCandidates(directPassive);
                }
                if (!passiveAgentValueForCandidate(text, passiveFirst[pz])) continue;
                var passiveVerbs = collectExactCandidates(searchState, passiveFirst[pz].end, endLimit);
                passiveVerbs.sort(compareCandidates);
                if (passiveVerbs.length > 4) passiveVerbs.length = 4;
                for (var pv = 0; pv < passiveVerbs.length; pv++) {
                    if (text[passiveVerbs[pv].end] !== '者') continue;
                    var agentPassive = buildPassiveZheBridgeCandidate(text, passiveFirst[pz], passiveVerbs[pv]);
                    addPassiveZheCandidates(agentPassive);
                }
            }
        }

        var particleSkipCandidate = buildParticleSkipCandidate(searchState, pos);
        if (particleSkipCandidate) candidates.push(particleSkipCandidate);

        if (allowPatterns && hasPatterns) {
            var prefixCandidates = collectPrefixPatternCandidates(searchState, pos, endLimit);
            for (var j = 0; j < prefixCandidates.length; j++) candidates.push(prefixCandidates[j]);
        }

        if (allowPatterns && hasPatterns && exactCandidates.length) {
            var exactForSuffix = exactCandidates.slice();
            exactForSuffix.sort(compareCandidates);
            if (exactForSuffix.length > 4) exactForSuffix.length = 4;
            for (var k = 0; k < exactForSuffix.length; k++) {
                var suffixCandidates = collectSuffixPatternCandidates(searchState, pos, endLimit, exactForSuffix[k]);
                for (var sk = 0; sk < suffixCandidates.length; sk++) candidates.push(suffixCandidates[sk]);
            }
        }

        var fallbackCandidate = buildFallbackCandidate(text, pos);
        candidates.push(fallbackCandidate);

        if (allowPatterns && hasPatterns) {
            var suffixFromFallback = collectSuffixPatternCandidates(searchState, pos, endLimit, fallbackCandidate);
            for (var fk = 0; fk < suffixFromFallback.length; fk++) candidates.push(suffixFromFallback[fk]);
        }

        candidates = dedupeAndLimitCandidates(candidates, allowPatterns ? SEARCH_MAX_CANDIDATES : CAPTURE_MAX_CANDIDATES);
        searchState.candidateCache[cacheKey] = candidates;
        return candidates;
    }

    // Translate a substring using best-path search without LuatNhan recursion.
    function trieTranslateRun(text, start, end, searchState) {
        if (!root || start >= end) return '';
        var owner = searchState || createSearchState(text, text);
        return translateSpanWithSearch(owner, start, end, false).text;
    }

    // Try prefix-based pattern match at position
    function tryPrefixPattern(text, pos, searchState) {
        var owner = searchState || createSearchState(text, text);
        var candidates = dedupeAndLimitCandidates(collectPrefixPatternCandidates(owner, pos, text.length), 1);
        if (!candidates.length) return null;
        return {
            len: candidates[0].len,
            compareLen: candidates[0].compareLen,
            value: candidates[0].value,
            score: candidates[0].score
        };
    }

    // Try suffix-only pattern after a Trie-matched segment
    function trySuffixPattern(text, pos) {
        var matches = collectSuffixPatternMatches(text, pos, text.length);
        if (!matches.length) return null;
        matches.sort(function (a, b) { return b.len - a.len; });
        return { len: matches[0].len, template: matches[0].template };
    }

    function finalizeTranslatedText(out) {
        out = normalizePunctuation(out);
        out = out.replace(/ ([.,!?;:\)\]\u00BB\u201D\u2019>])/g, '$1');
        out = out.replace(/([\(\[\u00AB\u201C\u2018<]) /g, '$1');
        out = cleanLineBreaks(out);
        out = out.replace(/ {2,}/g, ' ').trim();
        return capitalizeSentences(out);
    }

    var LEGACY_SOURCE_PARTICLE_DROP = {
        '的': true,
        '旳': true,
        '了': true,
        '着': true,
        '著': true,
        '地': true,
        '得': true,
        '过': true,
        '過': true,
        '嘛': true,
        '呢': true,
        '吧': true,
        '啊': true,
        '呀': true,
        '啦': true,
        '呐': true,
        '吶': true,
        '呗': true,
        '唄': true,
        '哩': true,
        '哟': true,
        '喲': true,
        '咯': true,
        '喽': true,
        '嘍': true,
        '罢': true,
        '罷': true
    };
    var LEGACY_NUMERIC_CAPTURE_RE = /^[零〇一二两兩三四五六七八九十百千万萬亿億半几幾多\d点點刻分秒时時小时小時天日月年岁歲余餘來来上下左右前后後余餘]+$/;
    var LEGACY_PARTICLE_DROP_RE = /\s+(liễu|đích|mạ)(?=\s|[.,!?;:”’’\)\]…—\-]|$)/giu;

    function legacyIsStandaloneParticleSource(zh) {
        return zh && zh.length === 1 && LEGACY_SOURCE_PARTICLE_DROP[zh];
    }

    function legacyStripParticles(str) {
        str = str.replace(LEGACY_PARTICLE_DROP_RE, '');
        str = str.replace(/ {2,}/g, ' ');
        str = str.replace(/ ([.,!?;:])/g, '$1');
        return str;
    }

    function legacyIsNumericCapture(text) {
        return !!text && LEGACY_NUMERIC_CAPTURE_RE.test(String(text || '').replace(/\s+/g, ''));
    }

    function legacyBetterExactCandidate(next, best) {
        if (!next) return best || null;
        if (!best) return next;
        if ((next.end - next.start) !== (best.end - best.start)) return (next.end - next.start) > (best.end - best.start) ? next : best;
        if ((next.pri | 0) !== (best.pri | 0)) return (next.pri | 0) > (best.pri | 0) ? next : best;
        return best;
    }

    function legacyOverlayMatchAt(text, pos, endLimit, overlayIndex) {
        if (!overlayIndex || !text[pos]) return null;
        var bucket = overlayIndex[text[pos]];
        if (!bucket || !bucket.length) return null;
        var best = null;
        for (var i = 0; i < bucket.length; i++) {
            var entry = bucket[i];
            if (!entry || !entry.zh) continue;
            var end = pos + entry.zh.length;
            if (end > endLimit || text.substring(pos, end) !== entry.zh) continue;
            best = legacyBetterExactCandidate({
                kind: 'trie',
                start: pos,
                end: end,
                len: end - pos,
                value: entry.value,
                pri: entry.pri | 0,
                key: entry.zh
            }, best);
        }
        return best;
    }

    function legacyTrieMatchAt(text, pos, endLimit) {
        if (!root) return null;
        var node = root, lastMatch = -1, lastValue = null, lastPri = 0, lastKey = '', j = pos;
        while (j < endLimit && node.c[text[j]]) {
            node = node.c[text[j]];
            j++;
            if (node.v !== null) {
                lastMatch = j;
                lastValue = node.v;
                lastPri = node.p | 0;
                lastKey = node.k || text.substring(pos, j);
            }
        }
        if (lastMatch > pos) {
            return {
                kind: 'trie',
                start: pos,
                end: lastMatch,
                len: lastMatch - pos,
                value: lastValue,
                pri: lastPri,
                key: lastKey
            };
        }
        return null;
    }

    function legacyPlainStepAt(text, pos, endLimit, overlayIndex) {
        var trie = legacyTrieMatchAt(text, pos, endLimit);
        var overlay = legacyOverlayMatchAt(text, pos, endLimit, overlayIndex);
        var best = legacyBetterExactCandidate(overlay, trie);
        if (best) return best;
        return {
            kind: 'phienam',
            start: pos,
            end: pos + 1,
            len: 1,
            value: phienamMap.get(text[pos]) || text[pos],
            pri: 0,
            key: text[pos]
        };
    }

    function legacyPatternCaptureAllowed(text, start, end, endLimit, overlayIndex) {
        if (start >= end) return false;
        var cap = text.substring(start, end);
        if (legacyIsNumericCapture(cap)) return true;
        var step = legacyPlainStepAt(text, start, endLimit, overlayIndex);
        return !!(step && step.kind === 'trie' && step.end === end);
    }

    function legacyPatternSplitsLongerExactTail(text, suffixStart, suffixLen, endLimit, overlayIndex) {
        var step = legacyPlainStepAt(text, suffixStart, endLimit, overlayIndex);
        return !!(step && step.kind === 'trie' && step.end > suffixStart + suffixLen);
    }

    function legacyTryPrefixPattern(text, pos, endLimit, overlayIndex) {
        if (!patPrefixRoot) return null;
        var node = patPrefixRoot;
        var i = pos;
        var best = null;
        while (i < endLimit && node.c[text[i]]) {
            node = node.c[text[i]];
            i++;
            if (!node.patterns) continue;
            for (var p = 0; p < node.patterns.length; p++) {
                var pat = node.patterns[p];
                if (pat.suffix.length === 0) continue;
                var sufIdx = text.indexOf(pat.suffix, i);
                while (sufIdx !== -1 && sufIdx + pat.suffix.length <= endLimit) {
                    var capLen = sufIdx - i;
                    if (capLen > 0 && capLen <= 8 && legacyPatternCaptureAllowed(text, i, sufIdx, endLimit, overlayIndex)) {
                        if (legacyPatternSplitsLongerExactTail(text, sufIdx, pat.suffix.length, endLimit, overlayIndex)) {
                            sufIdx = text.indexOf(pat.suffix, sufIdx + 1);
                            continue;
                        }
                        var totalLen = (i - pos) + capLen + pat.suffix.length;
                        if (!best || totalLen > best.len) {
                            best = {
                                kind: 'pattern',
                                len: totalLen,
                                end: pos + totalLen,
                                capStart: i,
                                capEnd: sufIdx,
                                suffixLen: pat.suffix.length,
                                template: pat.template
                            };
                        }
                        break;
                    }
                    sufIdx = text.indexOf(pat.suffix, sufIdx + 1);
                }
            }
        }
        return best;
    }

    function legacyTrySuffixPattern(text, pos, endLimit) {
        if (!patSuffixRoot) return null;
        var node = patSuffixRoot;
        var best = null;
        var i = pos;
        while (i < endLimit && node.c[text[i]]) {
            node = node.c[text[i]];
            i++;
            if (!node.templates) continue;
            var len = i - pos;
            for (var t = 0; t < node.templates.length; t++) {
                if (!best || len > best.suffixLen) best = { suffixLen: len, template: node.templates[t] };
            }
        }
        return best;
    }

    function legacySuffixCaptureAllowed(text, pos, base) {
        if (!base || base.len <= 0) return false;
        var cap = text.substring(pos, pos + base.len);
        if (base.len > 1) return true;
        if (legacyIsNumericCapture(cap)) return true;
        return pronounSet.has(cap);
    }

    function legacyStepAt(text, pos, endLimit, overlayIndex) {
        var base = legacyPlainStepAt(text, pos, endLimit, overlayIndex);
        if (hasPatterns && patPrefixRoot) {
            var prefix = legacyTryPrefixPattern(text, pos, endLimit, overlayIndex);
            if (prefix && (!base || base.kind !== 'trie' || prefix.len > base.len)) return prefix;
        }
        if (hasPatterns && patSuffixRoot && legacySuffixCaptureAllowed(text, pos, base)) {
            var suffix = legacyTrySuffixPattern(text, pos + base.len, endLimit);
            if (suffix && suffix.suffixLen) {
                return {
                    kind: 'pattern',
                    len: base.len + suffix.suffixLen,
                    end: pos + base.len + suffix.suffixLen,
                    capStart: pos,
                    capEnd: pos + base.len,
                    suffixLen: suffix.suffixLen,
                    template: suffix.template
                };
            }
        }
        return base;
    }

    function legacyTranslateRun(text, overlayIndex) {
        var out = [];
        var i = 0;
        while (i < text.length) {
            var step = legacyStepAt(text, i, text.length, overlayIndex);
            if (!step) {
                out.push(text[i]);
                i++;
                continue;
            }
            if (step.kind === 'pattern') {
                var capText = text.substring(step.capStart, step.capEnd);
                var capTranslated = legacyTranslateRun(capText, overlayIndex);
                out.push(step.template.replace('{0}', capTranslated));
                i += step.len;
            } else {
                var zh = text.substring(i, i + step.len);
                if (legacyIsStandaloneParticleSource(zh)) {
                    i += step.len;
                    continue;
                }
                if (step.value !== null && step.value !== undefined) out.push(String(step.value));
                else out.push(zh);
                i += step.len;
            }
        }
        return out.join(' ');
    }

    function segmentAndTranslateLegacy(text, opts) {
        if (!root || !text) return text;
        opts = opts || {};
        text = convertToSimplified(text);
        var overlayBundle = getOverlayBundle(opts.overlayEntries);
        var parts = [];
        var i = 0;
        while (i < text.length) {
            if (isCJK(text[i])) {
                var start = i;
                while (i < text.length && isCJK(text[i])) i++;
                parts.push(legacyTranslateRun(text.substring(start, i), overlayBundle.index));
            } else {
                var start2 = i;
                while (i < text.length && !isCJK(text[i])) i++;
                parts.push(text.substring(start2, i));
            }
        }
        var out = parts.join(' ');
        out = normalizePunctuation(out);
        out = out.replace(/ ([.,!?;:\)\]\u00BB\u201D\u2019>])/g, '$1');
        out = out.replace(/([\(\[\u00AB\u201C\u2018<]) /g, '$1');
        out = legacyStripParticles(out);
        out = cleanLineBreaks(out);
        out = out.replace(/ {2,}/g, ' ').trim();
        return capitalizeSentences(out);
    }

    function isSearchSegmentBoundary(ch) {
        return /[。？！；!?;]/.test(ch || '');
    }

    function isClosingQuoteOrBracket(ch) {
        return /[\u201D\u2019\u300D\u300F\u300B\u3011\u3009\]\)"'”’」』》】〉]/.test(ch || '');
    }

    function translateSegmentedText(searchState, text, allowPatterns) {
        var parts = [];
        var start = 0;

        function pushSpan(end) {
            if (end <= start) return;
            parts.push(translateSpanWithSearch(searchState, start, end, allowPatterns).text);
            start = end;
        }

        for (var i = 0; i < text.length; i++) {
            var ch = text[i];
            if (ch === '\r' || ch === '\n') {
                pushSpan(i);
                parts.push(ch);
                start = i + 1;
                continue;
            }
            if (!isSearchSegmentBoundary(ch)) continue;
            var end = i + 1;
            while (end < text.length && isClosingQuoteOrBracket(text[end])) end++;
            pushSpan(end);
            i = end - 1;
        }
        pushSpan(text.length);
        return parts.join(' ');
    }

    function segmentAndTranslateCurrent(text, opts) {
        if (!root) return text;
        opts = opts || {};
        var originalText = text;
        text = convertToSimplified(text);
        var overlayBundle = getOverlayBundle(opts.overlayEntries);
        text = protectMarkedHanVietTerms(text, overlayBundle.index);
        var alignedOriginalText = text.length === originalText.length ? originalText : text;
        var searchState = createSearchState(text, alignedOriginalText, {
            overlayEntries: opts.overlayEntries,
            _overlayBundle: overlayBundle,
            runtimeNameDetect: opts.runtimeNameDetect === true
        });
        var out = translateSegmentedText(searchState, text, hasPatterns && thuatToanNhan !== 0);
        return finalizeTranslatedText(out);
    }

    function segmentAndTranslate(text, opts) {
        opts = opts || {};
        var engineMode = opts.engineMode;
        if (!engineMode) {
            try { engineMode = localStorage.getItem('vp_engine_mode') || ''; } catch (e) { engineMode = ''; }
        }
        if (engineMode === 'current' || opts.useCurrentEngine === true) return segmentAndTranslateCurrent(text, opts);
        return segmentAndTranslateLegacy(text, opts);
    }

    function translate(text, opts) {
        return segmentAndTranslate(text, opts);
    }

    function translateWithOverlay(text, overlayEntries) {
        return segmentAndTranslate(text, { overlayEntries: overlayEntries || [] });
    }

    function translateCurrent(text, opts) {
        return segmentAndTranslateCurrent(text, opts || {});
    }

    function applyCustomEntries() {
        if (!root) return;
        // Re-key custom entries with simplified keys (in case loaded with traditional keys)
        var normalized = new Map();
        for (var entry of customEntries) {
            var zh = convertToSimplified(entry[0]);
            normalized.set(zh, entry[1]);
        }
        customEntries = normalized;
        for (var entry2 of customEntries) {
            var zh2 = entry2[0], vi = entry2[1], node = root;
            for (var j = 0; j < zh2.length; j++) {
                if (!node.c[zh2[j]]) node.c[zh2[j]] = createNode();
                node = node.c[zh2[j]];
            }
            node.v = vi; node.p = 999; node.s = 'custom'; node.k = zh2;
        }
    }

    // Common CJK chars with empty values in base dict — patch with correct Hán Việt
    var HANVIET_PATCH = {
        '\u7684': 'đích',
        '\u4E86': 'liễu',
        '\u65F3': 'đích',
        '\u5B81': 'ninh',
        '\u5BE7': 'ninh',
        '\u3749': 'ninh',
        '\u9766': 'điến',
        '\u4A44': 'điến',
        '\u649D': 'huy',
        '\u39D1': 'huy',
        '\u706E': 'quang'
    };
    function buildFromTSV(tsv) {
        cachedTSV = tsv;
        var all = parseTSV(tsv + (qualityOverrideTSV ? '\n' + qualityOverrideTSV : ''));
        if (all.length === 0) return false;
        // Normalize dict keys: Traditional → Simplified
        // Separate converted (Traditional) vs original (Simplified) entries.
        // Process converted first so originals override at same priority (>=).
        var converted = [], original = [], patEntries = [];
        for (var k = 0; k < all.length; k++) {
            var origKey = all[k][0];
            var simpKey = convertToSimplified(origKey);
            all[k][4] = origKey;
            all[k][0] = simpKey;
            if (simpKey.indexOf('{0}') !== -1) {
                var idx = simpKey.indexOf('{0}');
                patEntries.push({
                    prefix: simpKey.substring(0, idx),
                    suffix: simpKey.substring(idx + 3),
                    template: all[k][1]
                });
            } else if (simpKey !== origKey) {
                converted.push(all[k]);
            } else {
                original.push(all[k]);
            }
        }
        var entries = converted.concat(original);
        root = buildTrie(entries);
        entryCount = entries.length;
        phienamMap.clear();
        for (var k = 0; k < entries.length; k++) {
            if (entries[k][0].length === 1 && entries[k][0] === (entries[k][4] || entries[k][0]) && (entries[k][2] | 0) <= 1 && entries[k][1])
                phienamMap.set(entries[k][0], entries[k][1]);
        }
        // Patch known missing Hán Việt readings
        for (var ch in HANVIET_PATCH) {
            var currentHv = phienamMap.get(ch);
            if (!currentHv || hasCJKText(currentHv)) phienamMap.set(ch, HANVIET_PATCH[ch]);
        }
        applyCustomEntries();
        buildPatterns(patEntries);
        ready = true;
        console.log('DictEngine: loaded', entries.length, 'entries,', phienamMap.size, 'phienam,', customEntries.size, 'custom');
        return true;
    }

    function entriesToTSV(entries) {
        var parts = [];
        for (var i = 0; i < entries.length; i++) {
            parts.push(entries[i][0] + '\t' + entries[i][1] + '\t' + entries[i][2] + '\t' + (entries[i][3] || 'QualityOverrides.txt'));
        }
        return parts.join('\n') + (parts.length ? '\n' : '');
    }

    function parseQualityOverrideText(text) {
        var entries = [];
        var lines = String(text || '').split('\n');
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line || line[0] === '#' || (line[0] === '/' && line[1] === '/')) continue;
            var eq = line.indexOf('=');
            if (eq < 1) continue;
            var pri = 10;
            var rest = line.substring(eq + 1).trim();
            var tab = rest.lastIndexOf('\t');
            if (tab !== -1) {
                var priRaw = rest.substring(tab + 1).trim();
                if (/^\d+$/.test(priRaw)) {
                    pri = parseInt(priRaw, 10);
                    rest = rest.substring(0, tab).trim();
                }
            }
            entries = entries.concat(parseDictText(line.substring(0, eq).trim() + '=' + rest + '\n', pri, 'QualityOverrides.txt'));
        }
        return entries;
    }

    function loadQualityOverrides() {
        return fetch(QUALITY_OVERRIDES_URL).then(function (resp) {
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            return resp.text();
        }).then(function (text) {
            qualityOverrideTSV = entriesToTSV(parseQualityOverrideText(text));
        }).catch(function () {
            qualityOverrideTSV = '';
        });
    }

    // ===== IndexedDB for imported dicts =====
    function openDB() {
        return new Promise(function (resolve, reject) {
            var req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = function (e) {
                var db = e.target.result;
                if (!db.objectStoreNames.contains('imports')) {
                    db.createObjectStore('imports', { keyPath: 'name' });
                }
            };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error); };
        });
    }

    // Save an imported file's TSV to IDB
    function saveImport(name, tsv, count) {
        return openDB().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction('imports', 'readwrite');
                tx.objectStore('imports').put({ name: name, tsv: tsv, count: count, date: Date.now() });
                tx.oncomplete = function () { db.close(); resolve(); };
                tx.onerror = function () { db.close(); reject(tx.error); };
            });
        });
    }

    // Get all imported files' TSV concatenated
    function loadAllImports() {
        return openDB().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction('imports', 'readonly');
                var req = tx.objectStore('imports').getAll();
                req.onsuccess = function () { db.close(); resolve(req.result || []); };
                req.onerror = function () { db.close(); resolve([]); };
            });
        });
    }

    // Delete a single import source
    function deleteImport(name) {
        return openDB().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction('imports', 'readwrite');
                tx.objectStore('imports').delete(name);
                tx.oncomplete = function () { db.close(); resolve(); };
                tx.onerror = function () { db.close(); reject(tx.error); };
            });
        });
    }

    // Delete all imports
    function clearAllImportsDB() {
        return openDB().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction('imports', 'readwrite');
                tx.objectStore('imports').clear();
                tx.oncomplete = function () { db.close(); resolve(); };
                tx.onerror = function () { db.close(); reject(tx.error); };
            });
        });
    }

    // ===== Public API =====

    function loadDictionary(url) {
        var dictUrl = url || loadedUrl;
        loadedUrl = dictUrl;
        // Load custom entries from localStorage
        try {
            var stored = localStorage.getItem('customDict');
            if (stored) customEntries = new Map(Object.entries(JSON.parse(stored)));
        } catch (e) { /* ignore */ }

        // Load trad→simp mapping in parallel with dict fetch
        var tradSimpReady = tradSimpMap ? Promise.resolve() : loadTradSimp();

        var qualityReady = loadQualityOverrides();

        var dictReady = fetch(dictUrl).then(function (resp) {
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            return resp.json();
        }).then(function (data) {
            if (!data.phienam) throw new Error('No phienam data');
            var keys = Object.keys(data.phienam);
            var parts = new Array(keys.length);
            for (var i = 0; i < keys.length; i++) {
                parts[i] = keys[i] + '\t' + data.phienam[keys[i]] + '\t0\tdict-default.json';
            }
            baseTSV = parts.join('\n') + '\n';
            return loadAllImports().then(function (imports) {
                var fullTSV = baseTSV;
                for (var i = 0; i < imports.length; i++) {
                    fullTSV += imports[i].tsv;
                }
                return fullTSV;
            }).catch(function () {
                return baseTSV;
            });
        });

        // Wait for both trad-simp map and dict data before building Trie
        return Promise.all([tradSimpReady, dictReady, qualityReady]).then(function (results) {
            return buildFromTSV(results[1]);
        });
    }

    // Import .txt content, persist to IDB under sourceName
    function importDictText(text, priority, sourceName) {
        var lineCount = countDictRecords(text);
        var name = sourceName || ('import_' + Date.now());
        var newEntries = parseDictText(text, priority || 10, name);
        if (newEntries.length === 0) return Promise.resolve(0);
        var extraParts = [];
        for (var i = 0; i < newEntries.length; i++) {
            extraParts.push(newEntries[i][0] + '\t' + newEntries[i][1] + '\t' + newEntries[i][2] + '\t' + (newEntries[i][3] || name));
        }
        var extraTSV = extraParts.join('\n') + '\n';
        buildFromTSV(cachedTSV + extraTSV);
        // Persist to IDB
        return saveImport(name, extraTSV, lineCount || newEntries.length).then(function () {
            return lineCount || newEntries.length;
        }).catch(function (e) {
            console.warn('DictEngine: IDB save failed:', e);
            return lineCount || newEntries.length;
        });
    }

    // Get list of imported sources [{name, count, date}]
    function getImportedSources() {
        return loadAllImports().then(function (imports) {
            return imports.map(function (imp) {
                return { name: imp.name, count: imp.count, date: imp.date };
            });
        }).catch(function () { return []; });
    }

    // Remove one imported source, rebuild trie
    function removeImportedSource(name) {
        return deleteImport(name).then(function () {
            return rebuildFromDB();
        });
    }

    // Clear all imported, rebuild trie
    function clearAllImported() {
        return clearAllImportsDB().then(function () {
            buildFromTSV(baseTSV);
        });
    }

    // Rebuild trie from baseTSV + all IDB imports
    function rebuildFromDB() {
        return loadAllImports().then(function (imports) {
            var fullTSV = baseTSV;
            for (var i = 0; i < imports.length; i++) fullTSV += imports[i].tsv;
            buildFromTSV(fullTSV);
        }).catch(function () {
            buildFromTSV(baseTSV);
        });
    }

    function segment(text) {
        if (!root) return [];
        text = convertToSimplified(text);
        var segments = [];
        var i = 0;
        while (i < text.length) {
            if (!isCJK(text[i])) { i++; continue; }
            var node = root, lastMatch = -1, lastValue = null, j = i;
            while (j < text.length && node.c[text[j]]) {
                node = node.c[text[j]]; j++;
                if (node.v !== null) { lastMatch = j; lastValue = node.v; }
            }
            if (lastMatch > i) {
                segments.push({ zh: text.substring(i, lastMatch), vi: lastValue });
                i = lastMatch;
            } else { segments.push({ zh: text[i], vi: phienamMap.get(text[i]) || '' }); i++; }
        }
        return segments;
    }

    function segmentDisplay(text) {
        if (!root) return [];
        text = convertToSimplified(text);
        var items = [];
        var idx = 0;
        var i = 0;
        while (i < text.length) {
            if (!isCJK(text[i])) {
                var s = i;
                while (i < text.length && !isCJK(text[i])) i++;
                items.push({ type: 'filler', text: text.substring(s, i) });
                continue;
            }
            var node = root, lastMatch = -1, lastValue = null, j = i;
            while (j < text.length && node.c[text[j]]) {
                node = node.c[text[j]]; j++;
                if (node.v !== null) { lastMatch = j; lastValue = node.v; }
            }
            var zh, vi;
            if (lastMatch > i) {
                zh = text.substring(i, lastMatch);
                vi = lastValue;
                i = lastMatch;
            } else {
                zh = text[i];
                vi = phienamMap.get(text[i]) || '';
                i++;
            }
            var hvParts = [];
            for (var k = 0; k < zh.length; k++) {
                hvParts.push(phienamMap.get(zh[k]) || zh[k]);
            }
            items.push({
                type: 'cjk',
                zh: zh,
                vi: vi,
                hv: hvParts.join(' '),
                idx: idx
            });
            idx++;
        }
        return items;
    }

    function hanviet(text) {
        text = convertToSimplified(text);
        var titleAlias = renderHanvietTitleAlias(text);
        if (titleAlias) return titleAlias;
        var result = [];
        var i = 0;
        while (i < text.length) {
            if (isCJK(text[i])) {
                result.push(phienamMap.get(text[i]) || text[i]);
                i++;
            } else {
                // Collect non-CJK run (punctuation, spaces, newlines, etc.)
                var s = i;
                while (i < text.length && !isCJK(text[i])) i++;
                result.push(text.substring(s, i));
            }
        }
        var out = result.join(' ').replace(/ {2,}/g, ' ');
        out = normalizePunctuation(out);
        out = out.replace(/ ([.,!?;:\)\]\u00BB\u201D\u2019>])/g, '$1');
        out = out.replace(/([\(\[\u00AB\u201C\u2018<]) /g, '$1');
        out = cleanLineBreaks(out);
        out = out.replace(/ {2,}/g, ' ').trim();
        return capitalizeSentences(out);
    }

    function addCustom(zh, vi) {
        zh = convertToSimplified(zh);
        customEntries.set(zh, vi);
        if (root) {
            var node = root;
            for (var j = 0; j < zh.length; j++) {
                if (!node.c[zh[j]]) node.c[zh[j]] = createNode();
                node = node.c[zh[j]];
            }
            node.v = vi; node.p = 999; node.s = 'custom'; node.k = zh;
        }
        try { localStorage.setItem('customDict', JSON.stringify(Object.fromEntries(customEntries))); } catch (e) {}
    }

    function removeCustom(zh) {
        zh = convertToSimplified(zh);
        if (!customEntries.has(zh)) return;
        customEntries.delete(zh);
        if (cachedTSV) buildFromTSV(cachedTSV);
        try { localStorage.setItem('customDict', JSON.stringify(Object.fromEntries(customEntries))); } catch (e) {}
    }

    function isCustom(zh) {
        return customEntries.has(convertToSimplified(zh));
    }

    function getCustomEntries() { return Object.fromEntries(customEntries); }

    function clearCustom() {
        customEntries.clear();
        if (cachedTSV) buildFromTSV(cachedTSV);
        try { localStorage.setItem('customDict', '{}'); } catch (e) {}
    }

    function setCustomEntries(obj) {
        // Normalize keys to simplified before storing
        var normalized = {};
        for (var key in obj) {
            if (obj.hasOwnProperty(key)) normalized[convertToSimplified(key)] = obj[key];
        }
        customEntries = new Map(Object.entries(normalized));
        if (cachedTSV) buildFromTSV(cachedTSV);
        try { localStorage.setItem('customDict', JSON.stringify(normalized)); } catch (e) {}
    }

    function reload() {
        root = null; ready = false; entryCount = 0;
        patPrefixRoot = null; patSuffixRoot = null; hasPatterns = false;
        phienamMap.clear();
        return loadDictionary();
    }

    // Get all imported sources with full TSV data (for backup)
    function getImportedSourcesFull() {
        return loadAllImports().catch(function () { return []; });
    }

    // Restore imports from backup: bulk put all records, then rebuild
    function restoreImports(arr) {
        if (!arr || !arr.length) return Promise.resolve(0);
        return openDB().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction('imports', 'readwrite');
                var store = tx.objectStore('imports');
                var count = 0;
                for (var i = 0; i < arr.length; i++) {
                    if (arr[i].name && arr[i].tsv) {
                        store.put(arr[i]);
                        count++;
                    }
                }
                tx.oncomplete = function () { db.close(); resolve(count); };
                tx.onerror = function () { db.close(); reject(tx.error); };
            });
        }).then(function (count) {
            return rebuildFromDB().then(function () { return count; });
        });
    }

    function setChuyenGianThe(val) {
        chuyenGianThe = !!val;
        localStorage.setItem('vp_chuyen_gian_the', chuyenGianThe ? '1' : '0');
        if (cachedTSV) buildFromTSV(cachedTSV);
    }

    function setThuatToanNhan(val) {
        thuatToanNhan = Math.max(0, Math.min(3, parseInt(val, 10) || 0));
        localStorage.setItem('vp_thuat_toan_nhan', String(thuatToanNhan));
    }

    window.DictEngine = {
        loadDictionary: loadDictionary,
        translate: translate,
        translateCurrent: translateCurrent,
        translateWithOverlay: translateWithOverlay,
        segment: segment,
        segmentDisplay: segmentDisplay,
        hanviet: hanviet,
        importDictText: importDictText,
        parseDictText: parseDictText,
        addCustom: addCustom,
        removeCustom: removeCustom,
        isCustom: isCustom,
        getCustomEntries: getCustomEntries,
        clearCustom: clearCustom,
        setCustomEntries: setCustomEntries,
        getImportedSources: getImportedSources,
        getImportedSourcesFull: getImportedSourcesFull,
        restoreImports: restoreImports,
        rebuildFromDB: rebuildFromDB,
        removeImportedSource: removeImportedSource,
        clearAllImported: clearAllImported,
        get customCount() { return customEntries.size; },
        get entryCount() { return entryCount; },
        get phienamCount() { return phienamMap.size; },
        get isReady() { return ready; },
        get chuyenGianThe() { return chuyenGianThe; },
        get thuatToanNhan() { return thuatToanNhan; },
        setChuyenGianThe: setChuyenGianThe,
        setThuatToanNhan: setThuatToanNhan,
        convertToSimplified: convertToSimplified,
        reload: reload
    };
})();