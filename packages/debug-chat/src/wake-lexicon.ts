/**
 * Data for turning names into the wake-word model's tokens (wake-tokens.ts).
 * Generated once from files, never fetched at run time:
 *
 * - KWS_TOKEN_LIST: every token of kws-zipformer-zh-en-3M-2025-12-20's
 *   tokens.txt (CMU phones with stress, pinyin initials and toned finals).
 *   The spotter refuses a keyword with any other token.
 * - PINYIN_TABLE: "<toned syllable>:<characters>" for the 3,755 characters of
 *   GB2312 level 1 and a few common in given names (杰咪克可琪…), each with its
 *   most common reading (pinyin-pro 3.26.0, used only to make this table).
 * - EN_NAMES: "<name>:<CMU phones, dot-joined>" for our lanes' names and about
 *   200 common given names and agent names, from the model's en.phone (CMU
 *   dict). Other Latin names go through wake-tokens.ts's letter-to-sound rules.
 */

export const KWS_TOKEN_LIST =
  "AA0 AA1 AA2 AE0 AE1 AE2 AH0 AH1 AH2 AO0 AO1 AO2 AW0 AW1 AW2 AY0 AY1 AY2 B CH D DH EH0 EH1 EH2 " +
  "ER0 ER1 ER2 EY0 EY1 EY2 F G HH IH0 IH1 IH2 IY0 IY1 IY2 JH K L M N NG OW0 OW1 OW2 OY0 OY1 OY2 P R " +
  "S SH T TH UH0 UH1 UH2 UW0 UW1 UW2 V W Y Z ZH a ai an ang ao b c ch d e ei en eng er f g h hm i " +
  "ia ian iang iao ie in ing iu ià iàn iàng iào iá ián iáng iáo iè ié iòng ióng iù iú iā iān iāng " +
  "iāo iē iě iōng iū iǎ iǎn iǎng iǎo iǒng iǔ j k l m n o ong ou p q r s sh t u ua uai uan uang ue " +
  "ui un uo uà uài uàn uàng uá uái uán uáng uè ué uì uí uò uó uā uāi uān uāng uē uě uī uō uǎ uǎi " +
  "uǎn uǎng uǐ uǒ w x y z zh à ài àn àng ào á ái án áng áo è èi èn èng èr é éi én éng ér ì ìn ìng í " +
  "ín íng ò òng òu ó óng óu ù ùn ú ún üè üě ā āi ān āng āo ē ēi ēn ēng ě ěi ěn ěng ěr ī īn īng ń ň " +
  "ō ōng ōu ū ūn ǎ ǎi ǎn ǎng ǎo ǐ ǐn ǐng ǒ ǒng ǒu ǔ ǔn ǘ ǚ ǜ ǹ ḿ";

export const PINYIN_TABLE =
  "a:啊 ā:阿 āi:埃挨哎哀 ài:唉艾碍爱隘 ái:皑癌 ǎi:蔼矮 ān:鞍氨安 ǎn:俺 àn:按暗岸胺案 āng:肮 áng:昂 àng:盎 āo:凹 áo:敖熬翱嚣 ǎo:袄 " +
  "ào:傲奥懊澳 bā:芭捌扒叭笆八疤巴 ba:吧 bá:拔跋 bǎ:靶把 pá:耙爬琶 bà:坝霸罢爸 bái:白 bǎi:柏百摆佰 bài:败拜稗 bān:斑班搬扳般颁 bǎn:板版 " +
  "bàn:扮拌伴瓣半办绊 bāng:邦帮梆 bǎng:榜膀绑 bàng:棒磅蚌镑傍谤 bāo:苞胞包褒剥 báo:薄雹 bǎo:保堡饱宝 bào:抱报暴豹鲍爆 bēi:杯碑悲卑 běi:北 " +
  "bèi:辈背贝钡倍狈备惫焙被 bēn:奔 běn:苯本 bèn:笨 bēng:崩绷 béng:甭 bèng:泵蹦迸 bī:逼 bí:鼻 bǐ:比鄙笔彼 bì:碧蓖蔽毕毙毖币庇痹闭敝弊必壁臂避陛 " +
  "pì:辟僻屁譬 biān:鞭边编 biǎn:贬扁 biàn:便变卞辨辩辫遍 biāo:标彪膘 biǎo:表 biē:鳖憋 bié:别 biě:瘪 bīn:彬斌濒滨宾 bìn:摈 bīng:兵冰 " +
  "bǐng:柄丙秉饼炳 bìng:病并 bō:玻菠播拨钵波 bó:博勃搏铂箔伯帛舶脖膊渤泊驳簿 bǔ:捕卜哺补 bù:埠不布步部怖 cā:擦 cāi:猜 cái:裁材才财 cǎi:睬踩采彩 " +
  "cài:菜蔡 cān:餐参 cán:蚕残惭 cǎn:惨 càn:灿 cāng:苍舱仓沧 cáng:藏 cāo:操糙 cáo:槽曹 cǎo:草 cè:厕策侧册测 céng:层曾 cèng:蹭 " +
  "chā:插叉 chá:茬茶查碴搽察 chà:岔差诧刹 chāi:拆 chái:柴豺 chān:搀掺 chán:蝉馋谗缠 chǎn:铲产阐 chàn:颤 chāng:昌猖 chǎng:场厂敞 " +
  "cháng:尝常长偿肠 chàng:畅唱倡 chāo:超抄钞 cháo:朝嘲潮巢 chǎo:吵炒 chē:车 chě:扯 chè:撤掣彻澈 chēn:郴琛 chén:臣辰尘晨忱沉陈 " +
  "chèn:趁衬 chēng:撑称 chéng:城橙成呈乘程惩澄诚承 chěng:逞骋 chèng:秤 chī:吃痴 chí:持匙池迟弛驰 chǐ:耻齿侈尺 chì:赤翅斥炽 chōng:充冲 " +
  "chóng:虫崇 chǒng:宠 chōu:抽 chóu:酬畴踌稠愁筹仇绸 chǒu:瞅丑 chòu:臭 chū:初出 chú:橱厨躇锄雏滁除 chǔ:楚础储 chù:矗搐触处畜 " +
  "chuāi:揣 chuān:川穿 chuán:椽传船 chuǎn:喘 chuàn:串 chuāng:疮窗 zhuàng:幢撞壮状 chuáng:床 chuǎng:闯 chuàng:创 " +
  "chuī:吹炊 chuí:捶锤垂 chūn:春椿 chún:醇唇淳纯 chǔn:蠢 chuō:戳 chuò:绰 cī:疵 cí:茨磁雌辞慈瓷词 cǐ:此 cì:刺赐次 cōng:聪葱囱匆 " +
  "cóng:从丛 còu:凑 cū:粗 cù:醋簇促 cuān:蹿 cuàn:篡窜 cuī:摧崔催 cuì:脆瘁粹淬翠 cūn:村 cún:存 cùn:寸 cuō:磋撮搓 cuò:措挫错 " +
  "dā:搭 dá:达答 da:瘩 dǎ:打 dà:大 dāi:呆 dǎi:歹傣逮 dài:戴带殆代贷袋待怠 dān:耽担丹单郸 dǎn:掸胆 dàn:旦氮但惮淡诞蛋 tán:弹坛檀痰潭谭谈 " +
  "dāng:当 dǎng:挡党 dàng:荡档 dāo:刀 dǎo:捣蹈倒岛祷导 dào:到稻悼道盗 dé:德得 de:的 dēng:蹬灯登 děng:等 dèng:瞪凳邓 dī:堤低滴 " +
  "dí:迪敌笛狄涤嫡 zhái:翟宅 dǐ:抵底 dì:地蒂第帝弟递缔 diān:颠掂滇 diǎn:碘点典 diàn:靛垫电佃甸店惦奠淀殿 diāo:碉叼雕凋刁 diào:掉吊钓 " +
  "tiáo:调条迢 diē:跌爹 dié:碟蝶迭谍叠 dīng:丁盯叮钉 dǐng:顶鼎 dìng:锭定订 diū:丢 dōng:东冬 dǒng:董懂 dòng:动栋侗恫冻洞 dōu:兜都 " +
  "dǒu:抖陡 dòu:斗豆逗痘 dū:督 dú:毒犊独读 dǔ:堵睹赌 dù:杜镀肚度渡妒 duān:端 duǎn:短 duàn:锻段断缎 duī:堆 duì:兑队对 dūn:墩吨蹲敦 " +
  "dùn:顿钝盾遁 tún:囤屯臀 duō:掇哆多 duó:夺 duò:垛跺舵剁惰堕 duǒ:躲朵 é:蛾峨鹅俄额讹娥 è:恶厄扼遏鄂饿 ēn:恩 ér:而儿 ěr:耳尔饵洱 èr:二贰 " +
  "fā:发 fá:罚筏伐乏阀 fǎ:法 fà:珐 fān:藩帆番翻 fán:樊矾钒繁凡烦 fǎn:反返 fàn:范贩犯饭泛 fāng:坊芳方 fáng:肪房防妨 fǎng:仿访纺 fàng:放 " +
  "fēi:菲非啡飞 féi:肥 fěi:匪诽 fèi:吠肺废沸费 fēn:芬酚吩氛分纷 fén:坟焚汾 fěn:粉 fèn:奋份忿愤粪 fēng:丰封枫蜂峰锋风疯烽 féng:逢冯 " +
  "fèng:缝奉凤 fěng:讽 fó:佛 fǒu:否 fū:夫敷肤孵 fú:扶拂辐幅氟符伏俘服浮涪福袱弗 fǔ:甫抚辅俯釜斧腑府腐 pú:脯仆莆葡菩蒲 fù:赴副覆赋复傅付阜父腹负富讣附妇缚咐 " +
  "gá:噶 gǎ:嘎 gāi:该 gǎi:改 gài:概钙盖溉 gān:干甘杆柑竿肝 gǎn:赶感秆敢 gàn:赣 gāng:冈刚钢缸肛纲 gǎng:岗港 gàng:杠 gāo:篙皋高膏羔糕 " +
  "gǎo:搞稿 hào:镐耗号浩昊皓 gào:告 gē:哥歌搁戈鸽胳疙割咯 gé:革格阁隔 gě:葛 há:蛤 gè:铬个各 gěi:给 gēn:根跟 gēng:耕庚羹 gèng:更 " +
  "gěng:埂耿梗 gōng:工攻功恭龚躬公宫弓 gòng:供贡共 gǒng:巩汞拱 gōu:钩勾沟 gǒu:苟狗 gòu:垢构购够 gū:辜菇咕箍估沽孤姑 gǔ:鼓古蛊骨谷股 gù:故顾固雇 " +
  "guā:刮瓜 guǎ:剐寡 guà:挂褂 guāi:乖 guǎi:拐 guài:怪 guān:棺关官冠观 guǎn:管馆 guàn:罐惯灌贯 guāng:光 guǎng:广 guàng:逛 " +
  "guī:瑰规圭硅归龟闺 guǐ:轨鬼诡癸 guì:桂柜跪贵刽 gǔn:辊滚 gùn:棍 guō:锅郭 guó:国 guǒ:果裹 guò:过 hā:哈 hái:骸孩还 hǎi:海 " +
  "hài:氦亥害骇 hān:酣憨 hán:邯韩含涵寒函 hǎn:喊罕 hàn:翰撼捍旱憾悍焊汗汉 hāng:夯 háng:杭航 háo:壕嚎豪毫 hǎo:郝好 hē:呵喝 " +
  "hé:荷菏核禾和何合盒阂河涸 mò:貉末莫墨默沫漠寞陌 hè:赫褐鹤贺 hēi:嘿黑 hén:痕 hěn:很狠 hèn:恨 hēng:哼亨 héng:横衡恒 hōng:轰烘 hǒng:哄 " +
  "hóng:虹鸿洪宏弘红 hóu:喉侯猴 hǒu:吼 hòu:厚候后 hū:呼乎忽 hú:瑚壶葫胡蝴狐糊湖弧 hǔ:虎唬 hù:护互沪户 huā:花 huá:哗华猾滑 huà:画划化话 " +
  "huái:槐徊怀淮 huài:坏 huān:欢 huán:环桓 huǎn:缓 huàn:换患唤痪豢焕涣宦幻 huāng:荒慌 huáng:黄磺蝗簧皇凰惶煌 huàng:晃 huǎng:幌恍谎 " +
  "huī:灰挥辉徽恢 huí:蛔回 huǐ:毁悔 huì:慧卉惠晦贿秽会烩汇讳诲绘 hūn:荤昏婚 hún:魂浑 hùn:混 huō:豁 huó:活 huǒ:伙火 huò:获或惑霍货祸 " +
  "jī:击圾基机畸稽积箕肌饥激讥鸡姬缉 jì:迹绩蓟技冀季伎祭剂悸济寄寂计记既忌际妓继纪 jí:吉极棘辑籍集及急疾汲即嫉级 jǐ:挤几脊己 jiā:嘉枷佳家加 jiá:夹荚颊 jiǎ:贾甲钾假 " +
  "jià:稼价架驾嫁 jiān:歼监坚尖笺间煎兼肩艰奸缄 jiǎn:茧检柬碱硷拣捡简俭剪减 jiàn:荐鉴践贱见键箭件健舰剑饯渐溅涧建 kǎn:槛坎砍 jiāng:僵姜将浆江疆 " +
  "jiǎng:蒋桨奖讲 jiàng:匠酱降 jiāo:蕉椒礁焦胶交郊浇骄娇 jiáo:嚼 jiǎo:搅铰矫侥脚狡角饺缴绞剿 jiào:教酵轿较叫窖 jiē:揭接皆秸街阶 " +
  "jié:截劫节杰捷睫竭洁结 jú:桔菊局 jiě:解姐 jiè:戒藉芥界借介疥诫届 jīn:巾筋斤金今津襟 jǐn:紧锦仅谨瑾 jìn:进靳晋禁近烬浸尽劲 jīng:荆兢茎睛晶鲸京惊精粳经 " +
  "jǐng:井警景颈 jìng:静境敬镜径痉靖竟竞净 jiǒng:炯窘 jiū:揪究纠 jiǔ:玖韭久灸九酒 jiù:厩救旧臼舅咎就疚 jū:鞠拘狙疽居驹 zuǐ:咀嘴 jǔ:矩举沮 " +
  "jù:聚拒据巨具距踞锯俱句惧炬剧 juān:捐鹃娟 juàn:倦眷卷绢 juē:撅 jué:攫抉掘爵觉决诀绝 juè:倔 jūn:均菌钧军君 jùn:峻俊竣浚郡骏 kā:喀咖 kǎ:卡 " +
  "kāi:开揩 kǎi:楷凯慨 kān:刊堪勘 kàn:看 kāng:康慷糠 káng:扛 kàng:抗亢炕 kǎo:考拷烤 kào:靠 kē:坷苛柯棵磕颗科珂 ké:壳 hāi:咳 kě:可渴 " +
  "kè:克刻客课 kěn:肯啃垦恳 kēng:坑吭 kōng:空 kǒng:恐孔 kòng:控 kōu:抠 kǒu:口 kòu:扣寇 kū:枯哭窟 kǔ:苦 kù:酷库裤 kuā:夸 kuǎ:垮 " +
  "kuà:挎跨胯 kuài:块筷侩快 kuān:宽 kuǎn:款 kuāng:匡筐 kuáng:狂 kuàng:框矿眶旷况 kuī:亏盔岿窥 kuí:葵奎魁 kuǐ:傀 kuì:馈愧溃 " +
  "kūn:坤昆 kǔn:捆 kùn:困 kuò:括扩廓阔 lā:垃拉喇啦 là:蜡腊辣 lái:莱来 lài:赖 lán:蓝婪栏拦篮阑兰澜谰 lǎn:揽览懒缆 làn:烂滥 láng:琅榔狼廊郎 " +
  "lǎng:朗 làng:浪 lāo:捞 láo:劳牢 lǎo:老佬姥 lào:酪烙涝 lè:勒乐 léi:雷镭 lěi:蕾磊儡垒 lèi:累擂肋类泪 léng:棱楞 lěng:冷 " +
  "lí:厘梨犁黎篱狸离漓璃 lǐ:理李里鲤礼 lì:莉荔吏栗丽厉励砾历利傈例俐痢立粒沥隶力 lī:哩 liǎ:俩 lián:联莲连镰廉怜涟帘 liǎn:敛脸 liàn:链恋炼练 " +
  "liáng:粮凉梁粱良量 liǎng:两 liàng:辆晾亮谅 liáo:撩聊僚疗燎寥辽潦 liǎo:了 liào:撂镣廖料 liè:列裂烈劣猎 lín:琳林磷霖临邻鳞淋 lǐn:凛 " +
  "lìn:赁吝 līn:拎 líng:玲菱零龄铃伶羚凌灵陵 lǐng:岭领 lìng:另令 liū:溜 liú:琉榴硫馏留刘瘤流 liǔ:柳 liù:六 lóng:龙聋咙笼窿隆 lǒng:垄拢陇 " +
  "lóu:楼娄 lǒu:搂篓 lòu:漏陋 lú:芦卢颅庐炉 lǔ:掳卤虏鲁 lù:麓碌露路赂鹿潞禄录陆戮璐 lǘ:驴 lǚ:吕铝侣旅履屡缕 lǜ:虑氯律率滤绿 luán:峦挛孪滦 luǎn:卵 " +
  "luàn:乱 lüè:掠略 lūn:抡 lún:轮伦仑沦纶 lùn:论 luó:萝螺罗逻锣箩骡 luǒ:裸 luò:落洛骆络 mā:妈 má:麻 mǎ:玛码蚂马 mà:骂 ma:嘛吗 " +
  "mái:埋 mǎi:买 mài:麦卖迈脉 mán:瞒馒蛮 mǎn:满 màn:蔓曼慢漫谩 máng:芒茫盲氓忙 mǎng:莽 māo:猫 máo:茅锚毛矛 mǎo:铆卯 mào:茂冒帽貌贸 " +
  "me:么 méi:玫枚梅酶霉煤没眉媒 měi:镁每美 mèi:昧寐妹媚 mén:门 mēn:闷 men:们 méng:萌蒙檬盟 měng:锰猛 mèng:梦孟 mī:眯咪 mí:醚靡糜迷谜弥 " +
  "mǐ:米 mì:秘觅泌蜜密幂 mián:棉眠绵 miǎn:冕免勉娩缅 miàn:面 miáo:苗描瞄 miǎo:藐秒渺 miào:庙妙 miè:蔑灭 mín:民 mǐn:抿皿敏悯闽 " +
  "míng:明螟鸣铭名 mìng:命 miù:谬 mō:摸 mó:摹蘑模膜磨摩魔 mǒ:抹 móu:谋 mù:牟墓暮幕募慕木目睦牧穆 mǒu:某 mǔ:拇牡亩姆母 ná:拿 nǎ:哪 " +
  "nà:呐钠那娜纳 nǎi:氖乃奶 nài:耐奈 nán:南男难楠 náng:囊 náo:挠 nǎo:脑恼 nào:闹淖 ne:呢 něi:馁 nèi:内 nèn:嫩 néng:能 nī:妮 " +
  "ní:霓倪泥尼 nǐ:拟你 nì:匿腻逆溺 niān:蔫拈 nián:年粘 niǎn:碾撵捻辗 niàn:念 niáng:娘 niàng:酿 niǎo:鸟 niào:尿 niē:捏 " +
  "niè:聂孽啮镊镍涅 nín:您 níng:柠狞凝宁 nǐng:拧 nìng:泞 niú:牛 niǔ:扭钮纽 nóng:脓浓农 nòng:弄 nú:奴 nǔ:努 nù:怒 nǚ:女 " +
  "nuǎn:暖 nüè:虐疟 nuó:挪 nuò:懦糯诺 ò:哦 ōu:欧鸥殴沤 ǒu:藕呕偶 pā:啪趴 pà:帕怕 pāi:拍 pái:排牌徘 pài:湃派 pān:攀潘 pán:盘磐 " +
  "pàn:盼畔判叛 pāng:乓 páng:庞旁 pǎng:耪 pàng:胖 pāo:抛 páo:咆刨袍 pào:炮泡 pǎo:跑 pēi:呸胚 péi:培裴赔陪 pèi:配佩沛 pēn:喷 " +
  "pén:盆 pēng:砰抨烹 péng:澎彭蓬棚硼篷膨朋鹏 pěng:捧 pèng:碰 pī:坯砒霹批披劈 pí:琵毗啤脾疲皮 pǐ:匹痞 piān:篇偏 piàn:片骗 piāo:飘漂 " +
  "piáo:瓢 piào:票 piě:撇 piē:瞥 pīn:拼 pín:频贫 pǐn:品 pìn:聘 pīng:乒 píng:坪苹萍平凭瓶评屏 pō:坡泼颇 pó:婆 pò:破魄迫粕 " +
  "pōu:剖 pū:扑 pù:铺曝瀑 pǔ:埔朴圃普浦谱 qī:期欺栖戚妻七凄漆柒沏 qí:其棋奇歧畦崎脐齐旗祈祁骑琪琦淇 qǐ:起岂乞企启 qì:契砌器气迄弃汽泣讫 qiā:掐 qià:恰洽 " +
  "qiān:牵扦钎铅千迁签仟谦 qián:乾黔钱钳前潜 qiǎn:遣浅谴 qiàn:堑嵌欠歉茜 qiāng:枪腔羌 qiàng:呛 qiáng:墙蔷强 qiǎng:抢 qiāo:橇锹敲悄 " +
  "qiáo:桥瞧乔侨 qiǎo:巧 qiào:鞘撬翘峭俏窍 qiè:切怯窃 qié:茄 qiě:且 qīn:钦侵亲 qín:秦琴勤芹擒禽 qǐn:寝 qìn:沁 qīng:青轻氢倾卿清 " +
  "qíng:擎晴氰情 qǐng:顷请 qìng:庆 qióng:琼穷 qiū:秋丘邱 qiú:球求囚酋泅 qū:趋区蛆躯屈驱 qǔ:曲取娶龋 qú:渠 qù:趣去 quān:圈 " +
  "quán:颧权醛泉全痊拳 quǎn:犬 quàn:券劝 quē:缺炔 qué:瘸 què:却鹊榷确雀 qún:裙群 rán:然燃 rǎn:冉染 ráng:瓤 rǎng:壤攘嚷 ràng:让 " +
  "ráo:饶 rǎo:扰 rào:绕 rě:惹 rè:热 rén:壬仁人 rěn:忍 rèn:韧任认刃妊纫 rēng:扔 réng:仍 rì:日 róng:戎茸蓉荣融熔溶容绒 rǒng:冗 " +
  "róu:揉柔 ròu:肉 rú:茹蠕儒孺如 rǔ:辱乳汝 rù:入褥 ruǎn:软阮 ruǐ:蕊 ruì:瑞锐 rùn:闰润 ruò:若弱 sā:撒 sǎ:洒 sà:萨 sāi:腮鳃塞 " +
  "sài:赛 sān:三叁 sǎn:伞 sàn:散 sāng:桑 sǎng:嗓 sàng:丧 sāo:搔骚 sǎo:扫嫂 sè:瑟色涩 sēn:森 sēng:僧 shā:莎砂杀沙纱 shǎ:傻 " +
  "shá:啥 shà:煞厦 shāi:筛 shài:晒 shān:珊苫杉山删煽衫栅 shǎn:闪陕 shàn:擅赡膳善汕扇缮 shāng:墒伤商 shǎng:赏晌 shàng:上尚 " +
  "shang:裳 shāo:梢捎稍烧 sháo:芍勺韶 shǎo:少 shào:哨邵绍 shē:奢赊 shé:蛇舌 shè:舍赦摄射慑涉社设 shēn:砷申呻伸身深娠绅 shén:神什 " +
  "shěn:沈审婶 shèn:甚肾慎渗 shēng:声生甥牲升 shéng:绳 shěng:省 shèng:盛剩胜圣 shī:师失狮施湿诗尸虱 shí:十石拾时食蚀实识 shǐ:史矢使屎驶始 " +
  "shì:式示士世柿事拭誓逝势是嗜噬适仕侍释饰氏市恃室视试 shōu:收 shǒu:手首守 shòu:寿授售受瘦兽 shū:蔬枢梳殊抒输叔舒淑疏书 shú:赎孰熟 shǔ:薯暑曙署蜀黍鼠属 " +
  "shù:术述树束戍竖墅庶数漱恕 shuā:刷 shuǎ:耍 shuāi:摔衰 shuǎi:甩 shuài:帅 shuān:栓拴 shuāng:霜双 shuǎng:爽 shuí:谁 shuǐ:水 " +
  "shuì:睡税 shǔn:吮 shùn:瞬顺舜 shuō:说 shuò:硕朔烁 sī:斯撕嘶思私司丝 sǐ:死 sì:肆寺嗣四伺似饲巳 sōng:松 sǒng:耸怂 sòng:颂送宋讼诵 " +
  "sōu:搜艘 sǒu:擞 sòu:嗽 sū:苏酥 sú:俗 sù:素速粟僳塑溯宿诉肃 suān:酸 suàn:蒜算 suī:虽 suí:隋随绥 suǐ:髓 suì:碎岁穗遂隧祟 sūn:孙 " +
  "sǔn:损笋 suō:蓑梭唆缩 suǒ:琐索锁所 tā:塌他它她 tǎ:塔獭 tà:挞蹋踏 tāi:胎 tái:苔抬台 tài:泰酞太态汰 tān:坍摊贪瘫滩 tǎn:坦毯袒 tàn:碳探叹炭 " +
  "tāng:汤 táng:塘搪堂棠膛唐糖 tǎng:倘躺淌 tàng:趟烫 tāo:掏涛滔绦 táo:萄桃逃淘陶 tǎo:讨 tào:套 tè:特 téng:藤腾疼誊 tī:梯剔踢锑 " +
  "tí:提题蹄啼 tǐ:体 tì:替嚏惕涕剃屉 tiān:天添 tián:填田甜恬 tiǎn:舔腆 tiāo:挑 tiào:眺跳 tiē:贴帖 tiě:铁 tīng:厅听烃汀 " +
  "tíng:廷停亭庭婷 tǐng:挺艇 tōng:通 tóng:桐酮瞳同铜彤童 tǒng:桶捅筒统 tòng:痛 tōu:偷 tóu:投头 tòu:透 tū:凸秃突 tú:图徒途涂屠 tǔ:土吐 " +
  "tù:兔 tuān:湍 tuán:团 tuī:推 tuí:颓 tuǐ:腿 tuì:蜕褪退 tūn:吞 tuō:拖托脱 tuó:鸵陀驮驼 tuǒ:椭妥 tuò:拓唾 wā:挖哇蛙洼 wá:娃 " +
  "wǎ:瓦 wà:袜 wāi:歪 wài:外 wān:豌弯湾 wán:玩顽丸烷完 wǎn:碗挽晚皖惋宛婉 wàn:万腕 wāng:汪 wáng:王亡 wǎng:枉网往 wàng:旺望忘妄 " +
  "wēi:威巍微危薇 wéi:韦违桅围唯惟潍维 wèi:为未蔚味畏胃喂魏位渭谓尉慰卫 wěi:苇萎委伟伪尾纬 wēn:瘟温 wén:蚊文闻纹 wěn:吻稳紊 wèn:问 wēng:嗡翁 " +
  "wèng:瓮 wō:挝蜗涡窝 wǒ:我 wò:斡卧握沃 wū:巫呜钨乌污诬屋 wú:无芜梧吾吴毋 wǔ:武五捂午舞伍侮 wù:坞戊雾晤物勿务悟误 " +
  "xī:昔熙析西硒矽晰嘻吸锡牺稀息希悉膝夕惜熄烯溪汐犀曦 xí:檄袭席习媳 xǐ:喜洗 xiǎn:铣显险 xì:系隙戏细 xiā:瞎虾 xiá:匣霞辖暇峡侠狭 xià:下夏吓 " +
  "xiān:掀锨先仙鲜纤 xián:咸贤衔舷闲涎弦嫌 xiàn:现献县腺馅羡宪陷限线 xiāng:相厢镶香箱襄湘乡 xiáng:翔祥详 xiǎng:想响享 xiàng:项巷橡像向象 " +
  "xiāo:萧硝霄削销消宵 xiào:哮孝校肖啸笑效 xiáo:淆 xiǎo:晓小 xiē:楔些歇蝎 xié:鞋协挟携邪斜胁谐 xiě:写 xiè:械卸蟹懈泄泻谢屑 xīn:薪芯锌欣辛新忻心 " +
  "xìn:信衅 xīng:星腥猩惺兴 xíng:刑型形邢行 xǐng:醒 xìng:幸杏性姓 xiōng:兄凶胸匈汹 xióng:雄熊 xiū:休修羞 xiǔ:朽 xiù:嗅锈秀袖绣 " +
  "xū:墟戌需虚嘘须吁 xú:徐 xǔ:许 xù:蓄酗叙旭序恤絮婿绪续 xuān:轩喧宣萱 xuán:悬旋玄璇 xuǎn:选癣 xuàn:眩绚 xuē:靴薛 xué:学穴 xuě:雪 xuè:血 " +
  "xūn:勋熏 xún:循旬询寻巡 xùn:驯殉汛训讯逊迅 yā:压押鸦鸭丫 ya:呀 yá:芽牙蚜崖衙涯 yǎ:雅哑 yà:亚讶轧 yān:焉阉烟淹 yàn:咽艳堰燕厌砚雁唁彦焰宴谚验 " +
  "yán:盐严研蜒岩延言颜阎炎沿妍 yǎn:奄掩眼衍演 yāng:殃央鸯秧 yáng:杨扬佯疡羊洋阳 yǎng:氧仰痒养 yàng:样漾 yāo:邀腰妖 yáo:瑶摇尧遥窑谣姚 yǎo:咬舀 " +
  "yào:药要耀钥 yē:椰噎耶 yé:爷 yě:野冶也 yè:页掖业叶曳腋夜液 yī:一壹医揖铱依伊衣 yí:颐夷遗移仪胰疑沂宜姨彝 yǐ:椅蚁倚已乙矣以 " +
  "yì:艺抑易邑屹亿役臆逸肄疫亦裔意毅忆义益溢诣议谊译异翼翌绎 yīn:茵因殷音阴姻 yìn:荫印 yín:吟银淫寅 yǐn:饮尹引隐 yīng:英樱婴鹰缨 yìng:应硬映 " +
  "yíng:莹萤营荧蝇迎赢盈 yǐng:影颖 yō:哟 yōng:拥佣臃痈庸雍 yǒng:踊蛹咏泳涌永恿勇 yòng:用 yōu:幽优悠忧 yóu:尤由邮铀犹油游 yǒu:酉有友 " +
  "yòu:右佑釉诱又幼 yū:迂淤 yú:于盂榆虞愚舆余俞逾鱼愉渝渔隅娱瑜 yǔ:予雨与屿禹宇语羽 yù:玉域芋郁遇喻峪御愈欲狱育誉浴寓裕预豫驭煜钰 yuān:鸳渊冤 " +
  "yuán:元垣袁原援辕园员圆猿源缘 yuǎn:远 yuàn:苑愿怨院 yuē:曰约 yuè:越跃岳粤月悦阅玥 yún:耘云郧匀芸 yǔn:陨允 yùn:运蕴酝韵孕 yūn:晕 zā:匝 " +
  "zá:砸杂 zāi:栽哉灾 zǎi:宰载仔 zài:再在 zán:咱 zǎn:攒 zàn:暂赞 zāng:赃脏 zàng:葬 zāo:遭糟 záo:凿 zǎo:藻枣早澡蚤 zào:躁噪造皂灶燥 " +
  "zé:责择则泽 zéi:贼 zěn:怎 zēng:增憎 zèng:赠 zhā:扎喳渣 zhá:札铡闸 zhǎ:眨 zhà:榨乍炸诈柞 zǎ:咋 zhāi:摘斋 zhǎi:窄 zhài:债寨 " +
  "zhān:瞻毡詹沾 zhǎn:盏斩崭展 zhàn:蘸栈占战站湛绽 zhāng:樟章彰漳张 zhǎng:掌涨 zhàng:杖丈帐账仗胀瘴障 zhāo:招昭 zhǎo:找沼 zhào:赵照罩兆肇召 " +
  "zhē:遮 zhé:折哲蛰辙 zhě:者锗 zhè:蔗这浙 zhēn:珍斟真甄砧臻贞针侦帧 zhěn:枕疹诊 zhèn:震振镇阵 zhēng:蒸睁征狰争怔 zhèng:挣正政症郑证 " +
  "zhěng:整拯 zhī:芝枝支吱蜘知肢脂汁之织只 zhí:职直植殖执值侄 zhǐ:址指止趾旨纸 zhì:志挚掷至致置帜峙制智秩稚质炙痔滞治窒 zhōng:中盅忠钟衷终 zhǒng:种肿 " +
  "zhòng:重仲众 zhōu:舟周州洲诌粥 zhóu:轴 zhǒu:肘帚 zhòu:咒皱宙昼骤 zhū:珠株蛛朱猪诸诛 zhú:逐竹烛 zhǔ:煮拄瞩嘱主 zhù:著柱助蛀贮铸筑住注祝驻 " +
  "zhuā:抓 zhuǎ:爪 zhuài:拽 zhuān:专砖 zhuǎn:转 zhuàn:撰赚篆 zhuāng:桩庄装妆 zhuī:椎锥追 zhuì:赘坠缀 zhūn:谆 zhǔn:准 " +
  "zhuō:捉拙桌 zhuó:卓琢茁酌啄灼浊 zhe:着 zī:兹咨资姿滋淄孜 zǐ:紫籽滓子梓 zì:自渍字 zōng:鬃棕踪宗综 zǒng:总 zòng:纵 zōu:邹 zǒu:走 " +
  "zòu:奏揍 zū:租 zú:足卒族 zǔ:祖诅阻组 zuàn:钻 zuǎn:纂 zuì:醉最罪 zūn:尊遵 zuó:昨 zuǒ:左佐 zuò:做作坐座";

export const EN_NAMES =
  "coco:K.OW1.K.OW2 claude:K.L.AO1.D gemini:JH.EH1.M.AH0.N.AY2 jamie:JH.EY1.M.IY0 " +
  "jimmy:JH.IH1.M.IY0 main:M.EY1.N anna:AE1.N.AH0 alice:AE1.L.AH0.S amy:EY1.M.IY0 andy:AE1.N.D.IY0 " +
  "ben:B.EH1.N bella:B.EH1.L.AH0 bob:B.AA1.B charlie:CH.AA1.R.L.IY0 chloe:K.L.OW1.IY0 " +
  "chris:K.R.IH1.S claire:K.L.EH1.R daisy:D.EY1.Z.IY0 dan:D.AE1.N david:D.EY1.V.IH0.D " +
  "eddie:EH1.D.IY0 ella:EH1.L.AH0 emily:EH1.M.IH0.L.IY0 emma:EH1.M.AH0 eric:EH1.R.IH0.K " +
  "eva:EY1.V.AH0 felix:F.IY1.L.IH0.K.S finn:F.IH1.N frank:F.R.AE1.NG.K george:JH.AO1.R.JH " +
  "grace:G.R.EY1.S hannah:HH.AE1.N.AH0 harry:HH.EH1.R.IY0 henry:HH.EH1.N.R.IY0 iris:AY1.R.AH0.S " +
  "ivy:AY1.V.IY0 jack:JH.AE1.K jake:JH.EY1.K james:JH.EY1.M.Z jane:JH.EY1.N jason:JH.EY1.S.AH0.N " +
  "jenny:JH.EH1.N.IY0 jerry:JH.EH1.R.IY0 jess:JH.EH1.S joe:JH.OW1 john:JH.AA1.N josh:JH.AA1.SH " +
  "judy:JH.UW1.D.IY0 julia:JH.UW1.L.Y.AH0 kate:K.EY1.T katie:K.EY1.T.IY0 kelly:K.EH1.L.IY0 " +
  "kevin:K.EH1.V.IH0.N kim:K.IH1.M kitty:K.IH1.T.IY0 lily:L.IH1.L.IY0 lisa:L.IY1.S.AH0 " +
  "lucy:L.UW1.S.IY0 luke:L.UW1.K luna:L.UW1.N.AH0 max:M.AE1.K.S mia:M.IY1.AH0 mike:M.AY1.K " +
  "mila:M.AY1.L.AH0 molly:M.AA1.L.IY0 nancy:N.AE1.N.S.IY0 nick:N.IH1.K nina:N.IY1.N.AH0 " +
  "noah:N.OW1.AH0 oliver:AA1.L.AH0.V.ER0 olivia:OW0.L.IH1.V.IY0.AH0 oscar:AO1.S.K.ER0 " +
  "peter:P.IY1.T.ER0 penny:P.EH1.N.IY0 rachel:R.EY1.CH.AH0.L ray:R.EY1 rose:R.OW1.Z " +
  "ruby:R.UW1.B.IY0 ryan:R.AY1.AH0.N sam:S.AE1.M sara:S.EH1.R.AH0 sarah:S.EH1.R.AH0 " +
  "sophie:S.OW1.F.IY0 steve:S.T.IY1.V tom:T.AA1.M tony:T.OW1.N.IY0 una:UW1.N.AH0 " +
  "victor:V.IH1.K.T.ER0 zoe:Z.OW1.IY0 leo:L.IY1.OW0 leon:L.IY1.AA0.N lena:L.IY1.N.AH0 " +
  "mary:M.EH1.R.IY0 mark:M.AA1.R.K paul:P.AO1.L anne:AE1.N nova:N.OW1.V.AH0 echo:EH1.K.OW0 " +
  "sky:S.K.AY1 river:R.IH1.V.ER0 robin:R.AA1.B.AH0.N sunny:S.AH1.N.IY0 kiki:K.IY1.K.IY0 " +
  "lulu:L.UW1.L.UW2 nana:N.AE1.N.AH0 mimi:M.IY1.M.IY0 lala:L.AA1.L.AH0 bobby:B.AA1.B.IY0 " +
  "teddy:T.EH1.D.IY0 buddy:B.AH1.D.IY0 rocky:R.AA1.K.IY0 lucky:L.AH1.K.IY0 milo:M.AY1.L.OW0 " +
  "oreo:AO1.R.IY0.OW0 sushi:S.UW1.SH.IY0 taro:T.EH1.R.OW0 hana:HH.AE1.N.AH0 ken:K.EH1.N " +
  "aki:AA1.K.IY0 hiro:HH.IH1.R.OW0 kai:K.AY1 mika:M.IY1.K.AH0 miko:M.AY1.K.OW0 tama:T.AA1.M.AH0 " +
  "tiger:T.AY1.G.ER0 panda:P.AE1.N.D.AH0 kiwi:K.IY1.W.IY0 mango:M.AE1.NG.G.OW0 peach:P.IY1.CH " +
  "apple:AE1.P.AH0.L honey:HH.AH1.N.IY0 sugar:SH.UH1.G.ER0 cookie:K.UH1.K.IY0 candy:K.AE1.N.D.IY0 " +
  "pepper:P.EH1.P.ER0 ginger:JH.IH1.N.JH.ER0 jasper:JH.AE1.S.P.ER0 atlas:AE1.T.L.AH0.S " +
  "orion:OW0.R.AY1.AH0.N apollo:AH0.P.AA1.L.OW0 athena:AH0.TH.IY1.N.AH0 juno:JH.UW1.N.OW0 " +
  "aurora:ER0.AO1.R.AH0 nyx:N.IH1.K.S sage:S.EY1.JH ash:AE1.SH blue:B.L.UW1 alpha:AE1.L.F.AH0 " +
  "beta:B.EY1.T.AH0 gamma:G.AE1.M.AH0 delta:D.EH1.L.T.AH0 sigma:S.IH1.G.M.AH0 omega:OW0.M.EH1.G.AH0 " +
  "jarvis:JH.AA1.R.V.AH0.S friday:F.R.AY1.D.IY0 siri:S.IH1.R.IY0 alexa:AH0.L.EH1.K.S.AH0 " +
  "bixby:B.IH1.K.S.B.IY0 claw:K.L.AO1 sonnet:S.AA1.N.IH0.T opus:OW1.P.AH0.S haiku:HH.AY1.K.UW0 " +
  "fable:F.EY1.B.AH0.L cody:K.OW1.D.IY0 cocoa:K.OW1.K.OW0 koko:K.OW1.K.OW0 agent:EY1.JH.AH0.N.T " +
  "pal:P.AE1.L partner:P.AA1.R.T.N.ER0 tutor:T.UW1.T.ER0 teacher:T.IY1.CH.ER0 sensei:S.EH1.N.S.EY2 " +
  "master:M.AE1.S.T.ER0 boss:B.AA1.S captain:K.AE1.P.T.AH0.N chief:CH.IY1.F doctor:D.AA1.K.T.ER0 " +
  "professor:P.R.AH0.F.EH1.S.ER0 codex:K.OW1.D.EH0.K.S agy:EY1.JH.IY1.W.AY1";
