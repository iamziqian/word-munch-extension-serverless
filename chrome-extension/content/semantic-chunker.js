// 五语言增强语义分段系统
// 支持：中文、英语、西班牙语、日语、韩语
class FiveLanguageSemanticChunker {
    constructor(options = {}) {
      // 初始化语言配置
      this.initializeLanguageConfigs();
      
      // 分段参数
      this.targetLength = options.targetLength || 600;
      this.maxLength = options.maxLength || 800;
      this.minLength = options.minLength || 150;
      
      console.log('Five Language Semantic Chunker 已初始化');
      console.log('支持语言:', Object.keys(this.languageConfigs).join(', '));
    }
  
    // 初始化五种语言配置
    initializeLanguageConfigs() {
      this.languageConfigs = {
        chinese: {
          name: '中文',
          code: 'zh',
          punctuation: /[。！？；]/,
          splitPattern: /[。！？；]\s*/,
          charPattern: /[\u4e00-\u9fff]/,
          wordPattern: /[\u4e00-\u9fff]{1,}/g,
          transitionWords: [
            // 顺序词
            '首先', '其次', '然后', '接着', '最后', '最终',
            '第一', '第二', '第三', '一方面', '另一方面',
            '一是', '二是', '三是', '四是', '五是',
            
            // 逻辑词
            '因此', '所以', '由于', '因为', '既然', '如果',
            '但是', '然而', '不过', '虽然', '尽管', '即使',
            '而且', '另外', '此外', '同时', '与此同时',
            
            // 举例词
            '例如', '比如', '譬如', '具体来说', '换句话说',
            '也就是说', '总的来说', '综上所述', '由此可见',
            '可见', '显然', '事实上', '实际上', '总之'
          ],
          stopWords: [
            '的', '了', '在', '是', '有', '和', '与', '或', '但', '而',
            '就', '都', '要', '可以', '能够', '这', '那', '这个', '那个',
            '一个', '一些', '一种', '一直', '一般', '可能', '应该', '需要',
            '非常', '很', '比较', '相当', '十分', '特别', '尤其', '特殊'
          ]
        },
        
        english: {
          name: 'English',
          code: 'en',
          punctuation: /[.!?]/,
          splitPattern: /[.!?]\s+/,
          charPattern: /[a-zA-Z]/,
          wordPattern: /\b[a-zA-Z]{2,}\b/g,
          transitionWords: [
            // Sequence words
            'first', 'firstly', 'second', 'secondly', 'third', 'thirdly',
            'next', 'then', 'after', 'afterward', 'finally', 'lastly',
            'initially', 'subsequently', 'eventually', 'ultimately',
            
            // Logic words
            'therefore', 'thus', 'hence', 'consequently', 'as a result',
            'because', 'since', 'due to', 'owing to', 'given that',
            'however', 'but', 'yet', 'nevertheless', 'nonetheless',
            'although', 'though', 'even though', 'while', 'whereas',
            'moreover', 'furthermore', 'additionally', 'besides',
            'in addition', 'also', 'likewise', 'similarly',
            
            // Example words
            'for example', 'for instance', 'such as', 'including',
            'specifically', 'particularly', 'especially', 'notably',
            'in other words', 'that is', 'namely', 'in fact',
            'actually', 'indeed', 'certainly', 'obviously',
            'in conclusion', 'to sum up', 'in summary', 'overall'
          ],
          stopWords: [
            'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at',
            'to', 'for', 'of', 'with', 'by', 'from', 'up', 'about',
            'into', 'through', 'during', 'before', 'after', 'above',
            'below', 'between', 'among', 'is', 'are', 'was', 'were',
            'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does',
            'did', 'will', 'would', 'could', 'should', 'may', 'might',
            'can', 'must', 'this', 'that', 'these', 'those', 'very',
            'more', 'most', 'some', 'many', 'much', 'few', 'little'
          ]
        },
        
        spanish: {
          name: 'Español',
          code: 'es',
          punctuation: /[.!?¡¿]/,
          splitPattern: /[.!?¡¿]\s+/,
          charPattern: /[a-záéíóúñü]/i,
          wordPattern: /\b[a-záéíóúñü]{2,}\b/gi,
          transitionWords: [
            // Palabras de secuencia
            'primero', 'segundo', 'tercero', 'luego', 'después',
            'entonces', 'finalmente', 'por último', 'al final',
            'inicialmente', 'posteriormente', 'eventualmente',
            
            // Palabras lógicas
            'por tanto', 'por lo tanto', 'así que', 'por consiguiente',
            'como resultado', 'debido a', 'porque', 'ya que', 'puesto que',
            'sin embargo', 'pero', 'aunque', 'a pesar de', 'no obstante',
            'mientras que', 'en cambio', 'por el contrario',
            'además', 'también', 'asimismo', 'igualmente', 'del mismo modo',
            
            // Palabras de ejemplo
            'por ejemplo', 'como', 'tal como', 'incluyendo',
            'específicamente', 'particularmente', 'especialmente',
            'en otras palabras', 'es decir', 'o sea', 'de hecho',
            'en realidad', 'ciertamente', 'obviamente', 'claramente',
            'en conclusión', 'para resumir', 'en resumen', 'en general'
          ],
          stopWords: [
            'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas',
            'y', 'o', 'pero', 'en', 'con', 'por', 'para', 'de', 'del',
            'al', 'desde', 'hasta', 'sobre', 'bajo', 'entre', 'durante',
            'es', 'son', 'fue', 'fueron', 'ser', 'estar', 'tener', 'hacer',
            'este', 'esta', 'estos', 'estas', 'ese', 'esa', 'esos', 'esas',
            'aquel', 'aquella', 'aquellos', 'aquellas', 'muy', 'más', 'menos',
            'mucho', 'poco', 'algunos', 'muchos', 'varios', 'todo', 'toda'
          ]
        },
        
        japanese: {
          name: '日本語',
          code: 'ja',
          punctuation: /[。！？]/,
          splitPattern: /[。！？]\s*/,
          charPattern: /[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf]/,
          wordPattern: /[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf]{1,}/g,
          transitionWords: [
            // 順序詞
            'まず', 'はじめに', 'つぎに', 'そして', 'それから',
            'その後', '最後に', '最終的に', '結局', '最終的には',
            '第一に', '第二に', '第三に', '一方で', '他方で',
            
            // 論理詞
            'したがって', 'そのため', 'だから', 'なぜなら', 'というのは',
            'しかし', 'でも', 'ただし', 'けれども', 'といっても',
            'それでも', 'にもかかわらず', 'とはいえ', 'むしろ',
            'また', 'さらに', 'その上', '同時に', '一緒に',
            
            // 例示詞
            '例えば', 'たとえば', 'のように', 'など', 'といった',
            '具体的に', '特に', 'とりわけ', 'なかでも', 'ことに',
            'つまり', 'すなわち', '言い換えれば', '実際に', '実は',
            'もちろん', '確かに', '明らかに', '結論として', '要するに'
          ],
          stopWords: [
            'の', 'に', 'は', 'を', 'が', 'で', 'と', 'から', 'まで',
            'より', 'へ', 'に対して', 'について', 'による', 'において',
            'である', 'です', 'だ', 'ある', 'いる', 'する', 'なる',
            'この', 'その', 'あの', 'どの', 'これ', 'それ', 'あれ',
            'どれ', 'ここ', 'そこ', 'あそこ', 'どこ', 'とても', 'とく',
            'ちょっと', 'すこし', 'たくさん', 'みんな', 'すべて', 'ぜんぶ'
          ]
        },
        
        korean: {
          name: '한국어',
          code: 'ko',
          punctuation: /[.!?]/,
          splitPattern: /[.!?]\s*/,
          charPattern: /[\uac00-\ud7af]/,
          wordPattern: /[\uac00-\ud7af]{1,}/g,
          transitionWords: [
            // 순서어
            '먼저', '처음에', '다음에', '그리고', '그다음',
            '그 후', '마지막으로', '최종적으로', '결국', '최종적으로는',
            '첫째', '둘째', '셋째', '한편', '다른 한편',
            
            // 논리어
            '따라서', '그래서', '그러므로', '왜냐하면', '때문에',
            '하지만', '그러나', '그런데', '그렇지만', '하지만',
            '그럼에도', '그럼에도 불구하고', '오히려', '반면에',
            '또한', '게다가', '더욱이', '동시에', '함께',
            
            // 예시어
            '예를 들어', '가령', '처럼', '등', '같은',
            '구체적으로', '특히', '특별히', '무엇보다', '특히나',
            '즉', '다시 말해서', '바꿔 말하면', '실제로', '사실',
            '물론', '확실히', '분명히', '결론적으로', '요약하면'
          ],
          stopWords: [
            '이', '그', '저', '의', '를', '을', '에', '와', '과',
            '로', '으로', '는', '은', '가', '이다', '있다', '하다',
            '되다', '같다', '보다', '이것', '그것', '저것', '어떤',
            '여기', '거기', '저기', '어디', '매우', '아주', '조금',
            '좀', '많이', '모두', '전부', '모든', '각각', '서로'
          ]
        }
      };
    }
  
    // 主要的语义分段方法
    async createSemanticChunks(textContent) {
      console.log('🚀 开始五语言语义分段，文本长度:', textContent.length);
      
      // 预处理文本
      const cleanText = this.preprocessText(textContent);
      
      // 检测语言分布
      const languageDistribution = this.detectLanguageDistribution(cleanText);
      console.log('🌍 语言分布:', this.formatLanguageDistribution(languageDistribution));
      
      // 选择分段策略
      let chunks = [];
      if (this.isMixedLanguage(languageDistribution)) {
        console.log('📝 使用混合语言分段策略');
        chunks = this.mixedLanguageChunking(cleanText, languageDistribution);
      } else {
        const primaryLanguage = this.getPrimaryLanguage(languageDistribution);
        console.log('📝 使用单语言分段策略:', this.languageConfigs[primaryLanguage]?.name || primaryLanguage);
        chunks = this.singleLanguageChunking(cleanText, primaryLanguage);
      }
      
      // 后处理优化
      chunks = this.postProcessChunks(chunks);
      
      console.log('✅ 语义分段完成');
      this.logChunkSummary(chunks);
      
      return chunks;
    }
  
    // 预处理文本
    preprocessText(text) {
      return text
        .replace(/\s+/g, ' ')  // 标准化空白字符
        .replace(/\n{2,}/g, '\n\n')  // 保留段落分隔
        .trim();
    }
  
    // 检测语言分布
    detectLanguageDistribution(text) {
      const distribution = {};
      let totalRelevantChars = 0;
      
      // 统计各语言字符数
      for (const [langCode, config] of Object.entries(this.languageConfigs)) {
        const matches = text.match(new RegExp(config.charPattern, 'g')) || [];
        const count = matches.length;
        distribution[langCode] = {
          count: count,
          percentage: 0, // 稍后计算
          name: config.name,
          code: config.code
        };
        totalRelevantChars += count;
      }
      
      // 计算百分比
      if (totalRelevantChars > 0) {
        for (const langCode in distribution) {
          distribution[langCode].percentage = 
            (distribution[langCode].count / totalRelevantChars) * 100;
        }
      }
      
      return distribution;
    }
  
    // 格式化语言分布显示
    formatLanguageDistribution(distribution) {
      return Object.entries(distribution)
        .filter(([_, data]) => data.percentage > 5) // 只显示占比>5%的语言
        .map(([langCode, data]) => 
          `${data.name}: ${data.percentage.toFixed(1)}%`
        )
        .join(', ');
    }
  
    // 判断是否为混合语言
    isMixedLanguage(distribution) {
      const significantLanguages = Object.entries(distribution)
        .filter(([_, data]) => data.percentage > 15) // 超过15%才算显著语言
        .length;
      
      return significantLanguages > 1;
    }
  
    // 获取主要语言
    getPrimaryLanguage(distribution) {
      let maxPercentage = 0;
      let primaryLang = 'english'; // 默认英语
      
      for (const [langCode, data] of Object.entries(distribution)) {
        if (data.percentage > maxPercentage) {
          maxPercentage = data.percentage;
          primaryLang = langCode;
        }
      }
      
      // 如果没有明显的主语言，使用英语
      return maxPercentage > 20 ? primaryLang : 'english';
    }
  
    // 单语言分段
    singleLanguageChunking(text, language) {
      const config = this.languageConfigs[language];
      if (!config) {
        console.warn('⚠️ 未找到语言配置，使用英语配置:', language);
        return this.singleLanguageChunking(text, 'english');
      }
      
      const sentences = this.splitIntoSentences(text, config);
      const chunks = [];
      let currentChunk = '';
      let currentTopic = '';
      let chunkCount = 0;
  
      for (let i = 0; i < sentences.length; i++) {
        const sentence = sentences[i];
        if (!sentence) continue;
  
        // 语义分析
        const hasTransition = this.hasTransitionSignal(sentence, config);
        const topicKeywords = this.extractTopicKeywords(sentence, config);
        const isTopicChanged = this.isTopicChange(currentTopic, topicKeywords.join(' '));
        
        // 分段决策
        const shouldBreak = this.shouldBreakChunk(
          currentChunk, sentence, hasTransition, isTopicChanged
        );
        
        if (shouldBreak && currentChunk.trim()) {
          chunks.push(this.finalizeSentence(currentChunk.trim(), config));
          chunkCount++;
          console.log(`📄 创建段落 ${chunkCount}: ${currentChunk.length} 字符`);
          
          currentChunk = sentence;
          currentTopic = topicKeywords.join(' ');
        } else {
          const separator = this.getSentenceSeparator(config, currentChunk);
          currentChunk += separator + sentence;
          
          if (!currentTopic && topicKeywords.length > 0) {
            currentTopic = topicKeywords.join(' ');
          }
        }
      }
  
      // 处理最后一个段落
      if (currentChunk.trim()) {
        chunks.push(this.finalizeSentence(currentChunk.trim(), config));
        chunkCount++;
        console.log(`📄 创建段落 ${chunkCount}: ${currentChunk.length} 字符`);
      }
  
      return chunks;
    }
  
    // 将文本分割为句子
    splitIntoSentences(text, config) {
      return text
        .split(config.splitPattern)
        .map(s => s.trim())
        .filter(s => s.length > 10); // 过滤太短的句子
    }
  
    // 判断是否需要分段
    shouldBreakChunk(currentChunk, newSentence, hasTransition, isTopicChanged) {
      const currentLength = currentChunk.length;
      const testLength = currentLength + newSentence.length;
      
      // 强制分段：超过最大长度
      if (testLength > this.maxLength) {
        return true;
      }
      
      // 如果当前段落太短，不分段
      if (currentLength < 200) {
        return false;
      }
      
      // 语义分段：检测到转换词且长度适中
      if (hasTransition && currentLength > 300) {
        return true;
      }
      
      // 主题变化分段：主题变化且长度适中
      if (isTopicChanged && currentLength > 400) {
        return true;
      }
      
      // 长度控制分段：接近目标长度
      if (testLength > this.targetLength && currentLength > 300) {
        return true;
      }
      
      return false;
    }
  
    // 混合语言分段
    mixedLanguageChunking(text, languageDistribution) {
      // 按段落预分割
      const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim());
      const chunks = [];
      
      for (const paragraph of paragraphs) {
        if (paragraph.trim().length < 50) continue;
        
        // 检测段落主要语言
        const paragraphLangDist = this.detectLanguageDistribution(paragraph);
        const paragraphLang = this.getPrimaryLanguage(paragraphLangDist);
        
        // 处理段落
        if (paragraph.length > this.maxLength) {
          const subChunks = this.splitLongParagraph(paragraph, paragraphLang);
          chunks.push(...subChunks);
        } else if (paragraph.length > this.minLength) {
          chunks.push(paragraph.trim());
        }
      }
      
      // 如果段落分割效果不好，使用通用分割
      if (chunks.length < 3) {
        console.log('⚠️ 段落分割效果不佳，使用通用分段');
        return this.universalChunking(text);
      }
      
      return chunks;
    }
  
    // 通用分段（适用于所有支持的语言）
    universalChunking(text) {
      // 使用通用标点符号
      const universalPunctuation = /[.!?。！？]/;
      const sentences = text.split(universalPunctuation)
        .map(s => s.trim())
        .filter(s => s.length > 15);
      
      const chunks = [];
      let currentChunk = '';
      
      for (const sentence of sentences) {
        const testChunk = currentChunk + (currentChunk ? '. ' : '') + sentence;
        
        if (testChunk.length > this.targetLength && currentChunk) {
          chunks.push(currentChunk + '.');
          currentChunk = sentence;
        } else {
          currentChunk = testChunk;
        }
        
        // 强制分段防止过长
        if (currentChunk.length > this.maxLength) {
          chunks.push(currentChunk + '.');
          currentChunk = '';
        }
      }
      
      if (currentChunk) {
        chunks.push(currentChunk + '.');
      }
      
      return chunks.filter(chunk => chunk.length > 30);
    }
  
    // 检测转换信号
    hasTransitionSignal(sentence, config) {
      const lowerSentence = sentence.toLowerCase();
      return config.transitionWords.some(word => 
        lowerSentence.includes(word.toLowerCase())
      );
    }
  
    // 提取主题关键词
    extractTopicKeywords(sentence, config) {
      const words = sentence.match(config.wordPattern) || [];
      
      return words
        .map(word => word.toLowerCase())
        .filter(word => !config.stopWords.includes(word))
        .filter(word => word.length >= 2)
        .slice(0, 3); // 取前3个关键词
    }
  
    // 判断主题变化
    isTopicChange(oldTopic, newTopic) {
      if (!oldTopic || !newTopic) return false;
      
      const oldWords = oldTopic.split(' ').filter(w => w);
      const newWords = newTopic.split(' ').filter(w => w);
      
      if (oldWords.length === 0 || newWords.length === 0) return false;
      
      const commonWords = oldWords.filter(word => newWords.includes(word));
      const overlapRate = commonWords.length / Math.max(oldWords.length, newWords.length);
      
      return overlapRate < 0.3; // 重叠率低于30%认为是主题变化
    }
  
    // 获取句子分隔符
    getSentenceSeparator(config, currentChunk) {
      if (!currentChunk) return '';
      
      // 根据语言特点选择分隔符
      if (config === this.languageConfigs.chinese || 
          config === this.languageConfigs.japanese) {
        return '。';
      } else {
        return '. ';
      }
    }
  
    // 完善句子结尾
    finalizeSentence(sentence, config) {
      if (!sentence) return sentence;
      
      const lastChar = sentence.slice(-1);
      const punctuationChars = ['.', '!', '?', '。', '！', '？', '¡', '¿'];
      
      if (!punctuationChars.includes(lastChar)) {
        // 根据语言添加合适的结尾标点
        if (config === this.languageConfigs.chinese || 
            config === this.languageConfigs.japanese) {
          return sentence + '。';
        } else {
          return sentence + '.';
        }
      }
      
      return sentence;
    }
  
    // 分割长段落
    splitLongParagraph(paragraph, language) {
      const config = this.languageConfigs[language] || this.languageConfigs.english;
      const sentences = this.splitIntoSentences(paragraph, config);
      const chunks = [];
      let currentChunk = '';
      
      for (const sentence of sentences) {
        const separator = this.getSentenceSeparator(config, currentChunk);
        const testChunk = currentChunk + separator + sentence;
        
        if (testChunk.length > this.targetLength && currentChunk) {
          chunks.push(this.finalizeSentence(currentChunk, config));
          currentChunk = sentence;
        } else {
          currentChunk = testChunk;
        }
      }
      
      if (currentChunk) {
        chunks.push(this.finalizeSentence(currentChunk, config));
      }
      
      return chunks;
    }
  
    // 后处理优化
    postProcessChunks(chunks) {
      console.log('🔧 开始后处理优化...');
      
      const optimized = [];
      let currentChunk = '';
      
      for (const chunk of chunks) {
        // 合并过短的段落
        if (chunk.length < this.minLength && currentChunk) {
          currentChunk += ' ' + chunk;
          console.log(`🔗 合并短段落: ${chunk.length} + ${currentChunk.length - chunk.length} = ${currentChunk.length}`);
        } else if (currentChunk && currentChunk.length > 100) {
          optimized.push(currentChunk.trim());
          currentChunk = chunk;
        } else {
          currentChunk = (currentChunk + ' ' + chunk).trim();
        }
        
        // 防止段落过长
        if (currentChunk.length > this.maxLength * 1.2) {
          optimized.push(currentChunk.trim());
          console.log(`✂️ 分割过长段落: ${currentChunk.length} 字符`);
          currentChunk = '';
        }
      }
      
      if (currentChunk && currentChunk.trim()) {
        optimized.push(currentChunk.trim());
      }
      
      const final = optimized.filter(chunk => chunk.length > 30);
      console.log(`✅ 后处理完成: ${chunks.length} → ${final.length} 段落`);
      
      return final;
    }
  
    // 记录分段摘要
    logChunkSummary(chunks) {
      console.log('\n📊 分段结果摘要:');
      console.log('─'.repeat(50));
      
      chunks.forEach((chunk, i) => {
        const preview = chunk.length > 40 ? chunk.substring(0, 40) + '...' : chunk;
        console.log(`${i+1}. [${chunk.length}字符] ${preview}`);
      });
      
      const totalChars = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const avgLength = Math.round(totalChars / chunks.length);
      
      console.log('─'.repeat(50));
      console.log(`📈 统计信息:`);
      console.log(`   总段落数: ${chunks.length}`);
      console.log(`   总字符数: ${totalChars}`);
      console.log(`   平均长度: ${avgLength} 字符`);
      console.log(`   最短段落: ${Math.min(...chunks.map(c => c.length))} 字符`);
      console.log(`   最长段落: ${Math.max(...chunks.map(c => c.length))} 字符`);
      console.log('─'.repeat(50));
    }
  
    // 获取支持的语言列表
    getSupportedLanguages() {
      return Object.entries(this.languageConfigs).map(([code, config]) => ({
        code: code,
        name: config.name,
        nativeName: config.code
      }));
    }
  
    // 设置分段参数
    setChunkingParameters(options) {
      if (options.targetLength) this.targetLength = options.targetLength;
      if (options.maxLength) this.maxLength = options.maxLength;
      if (options.minLength) this.minLength = options.minLength;
      
      console.log('📐 分段参数已更新:', {
        targetLength: this.targetLength,
        maxLength: this.maxLength,
        minLength: this.minLength
      });
    }
  }
  
  // 使用示例和集成类
  class FiveLanguageChunkerIntegration {
    constructor(options = {}) {
      this.chunker = new FiveLanguageSemanticChunker(options);
      console.log('🎯 Five Language Chunker Integration 已初始化');
    }
  
    // 主要接口：创建语义分段
    async createChunks(textContent) {
      try {
        console.log('🚀 开始创建语义分段...');
        const startTime = Date.now();
        
        const chunks = await this.chunker.createSemanticChunks(textContent);
        
        const endTime = Date.now();
        console.log(`⏱️ 分段耗时: ${endTime - startTime}ms`);
        
        return chunks;
      } catch (error) {
        console.error('❌ 语义分段失败:', error);
        // 回退到简单分段
        return this.fallbackChunking(textContent);
      }
    }
  
    // 回退分段方法
    fallbackChunking(textContent) {
      console.log('🔄 使用回退分段方法');
      
      const sentences = textContent
        .split(/[.!?。！？]\s*/)
        .map(s => s.trim())
        .filter(s => s.length > 20);
      
      const chunks = [];
      let currentChunk = '';
      
      for (const sentence of sentences) {
        const testChunk = currentChunk + (currentChunk ? '. ' : '') + sentence;
        
        if (testChunk.length > 600 && currentChunk) {
          chunks.push(currentChunk + '.');
          currentChunk = sentence;
        } else {
          currentChunk = testChunk;
        }
      }
      
      if (currentChunk) {
        chunks.push(currentChunk + '.');
      }
      
      return chunks.filter(chunk => chunk.length > 50);
    }
  
    // 获取支持的语言
    getSupportedLanguages() {
      return this.chunker.getSupportedLanguages();
    }
  
    // 设置参数
    setParameters(options) {
      this.chunker.setChunkingParameters(options);
    }
  }
  
  // 导出供扩展使用
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { 
      FiveLanguageSemanticChunker,
      FiveLanguageChunkerIntegration
    };
  }
  
  // 全局使用接口
  window.createFiveLanguageChunker = function(options = {}) {
    return new FiveLanguageChunkerIntegration(options);
  };
  
  console.log('📚 Five Language Semantic Chunker 已加载完成');
  console.log('支持语言: 中文、English、Español、日本語、한국어');