# Word Munch

## Inspiration

I'm reading some dense documentation. Hit a confusing sentence. Think "Did I get this right?"

Tab over to ChatGPT. "Can you clarify this?" Get my answer. Tab back.

My flow? Dead.

A week later, I see another long paragraph. My brain goes: "Nah, too much work." Copy, paste, "Summarize this." 

More time saved = more TikTok time. Win-win, right?

Wrong. I was training myself to be intellectually lazy. My reading muscles were atrophying while my scroll finger got stronger.

Word Munch was born from a simple question: What if I could get AI help without killing my reading flow—and actually get *better* at reading instead of avoiding it?

## What it does

Word Munch turns any webpage into your personal reading coach through three core features:

**Word Muncher**: Select any difficult word, get an instant simplified synonym in a floating window. Need another option? Hit "▶" for alternative explanations.

**Concept Muncher**: This is where it gets interesting. Select a complex sentence or paragraph, then write your own understanding in one sentence. Our system uses Amazon Titan Text Embeddings to compare your interpretation with the original meaning.

Here's the magic: the original text lights up with color-coded highlights showing exactly what you understood (green), partially grasped (yellow), or completely missed (no highlight). It's like having X-ray vision for your own comprehension gaps.

When you're struggling, Claude Haiku steps in with personalized feedback—not just "you got it wrong," but actionable advice like "try identifying the author's stance on this issue."

**Reading Chunk Mode**: Four scientifically-designed focus modes (gentle to extreme minimalism) that adapt the interface to match your concentration needs.

**Cognitive Profile**: The system quietly tracks your reading patterns, building a personal "comprehension radar" that reveals your strengths and blind spots over time.

## How I built it

My research revealed something fascinating: 70% of working memory during reading gets wasted on basic processing, leaving only 30% for actual analysis and synthesis. People don't know how to efficiently process and store information while reading. So when they hit dense jargon, the brain says "nope" and they copy-paste everything to ChatGPT. But since it's not their own thinking, they forget it instantly—turn around and it's gone.

I built a tool to offload that cognitive burden. Hit a difficult word? Double-click for instant context-based simplification—no mental gymnastics required. Still confused by a sentence? Write down your understanding, and the system compares it with the original meaning, showing exactly where comprehension broke down and where you could improve.

No more copy-pasting entire paragraphs to ChatGPT. The system only activates when you need it, making serverless architecture the perfect fit—AWS Lambda functions spring to life on demand, then hibernate until your next "help me" moment.

The tech stack: Chrome extension for real-time interaction, API Gateway and Lambda to handle user pain points, Amazon Bedrock for semantic analysis, DynamoDB for tracking progress, and a three-tier caching system to keep everything lightning-fast.

## Challenges I ran into

Manifest V3 threw me curveballs I didn't expect. Building a responsive popup window that doesn't lag? Harder than it sounds.

I implemented a three-tier caching system (memory → IndexedDB → DynamoDB) to keep everything snappy, but getting the balance right took dozens of iterations.

The real headaches started with text segmentation—how do you intelligently break sentences into meaningful chunks for comparison with user interpretations? Too small is fine, just slower computation. Too big and you can't pinpoint where exactly the user's understanding diverged from the original text.

Long paragraphs brought their own nightmares. Chunk them wrong and the semantic analysis goes haywire. Chunk them right and prevent cognitive overload—easier said than done.

Then came the economic puzzle: which Bedrock model gives the best bang for your buck? When exactly do you invoke the expensive AI models versus relying on cheaper embeddings? Every prompt optimization saved money but risked accuracy.

The visualization challenge was brutal—how do you show someone their comprehension gaps at a glance? I needed users to instantly spot their misunderstandings without drowning in complexity.

And designing those four focus modes? Balancing scientific rigor with user experience nearly broke my brain.

## Accomplishments that I'm proud of

The caching system actually works. Pages load instantly, even with complex AI processing running behind the scenes.

I found the semantic similarity sweet spot—accurate enough to catch real comprehension gaps, efficient enough not to break the bank.

The four focus modes with their visual interface got great user feedback. People actually use them.

Most importantly: I built something I genuinely use every day. Dense documentation doesn't feel like a wall anymore.

The serverless architecture scales beautifully without me losing sleep over sudden traffic spikes.

## What I learned

AI should augment human thinking, not replace it. The moment we outsource our cognition entirely, we stop growing intellectually. The sweet spot is AI that makes us think better, not AI that thinks for us.

Balancing savings and accuracy is an art when invoking AI models.

The best learning tools should be invisible—users shouldn't feel like they're "learning," they should just get better at what they're doing.

Semantic similarity isn't just about matching words—context is everything. Sometimes a completely different phrase captures the same meaning better than a word-for-word match.

## What's next for Word Munch

The comparison accuracy is good, but it could be great. I'm refining prompts and exploring multimodal models for even better comprehension analysis.

Next up: making this extension run everywhere. PDFs, e-books, documentation sites, research papers—anywhere people struggle with dense text should be fair game.

The real goal? Making Word Munch invisible—so seamlessly integrated into your reading flow that better comprehension just... happens.