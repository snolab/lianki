# Self-Introduction Feature

The Self-Introduction feature helps users learn how to introduce themselves in different languages using AI-powered translation and text-to-speech.

## How It Works

1. **Select Language**: User chooses the target language they want to learn
2. **Answer Questions**: AI asks 6 common self-introduction questions:
   - What is your name?
   - Where are you from?
   - How old are you?
   - What do you do?
   - What are your hobbies?
   - What languages do you speak?
3. **AI Translation**: Each answer is translated to the target language using GPT-4o-mini
4. **Voice Generation**: OpenAI TTS API generates natural-sounding audio for each sentence
5. **Save to Cards**: All sentences are saved as Lianki flashcards for spaced repetition learning

## Configuration

### Required Environment Variables

```bash
OPENAI_API_KEY=your_openai_api_key_here
```

### Voice Customization (Advanced Options)

Users can customize:

- **Voice**: Choose from 6 OpenAI voices (nova, alloy, echo, fable, onyx, shimmer)
- **Speech Rate**: Adjust from 0.25x (slow) to 2.0x (fast)
- **Gender**: Filter voices by gender (male, female, neutral)

## Supported Languages

- English
- Chinese (Mandarin)
- Japanese
- Korean
- Spanish
- French
- German
- Italian
- Portuguese
- Russian

## API Endpoints

### POST `/api/self-intro/translate`

Translates user answers to target language.

**Request:**

```json
{
  "answer": "Shanghai, China",
  "questionId": "from",
  "targetLanguage": "ja-JP"
}
```

**Response:**

```json
{
  "translatedText": "私は中国の上海出身です。"
}
```

### POST `/api/self-intro/tts`

Generates audio from translated text.

**Request:**

```json
{
  "text": "私は中国の上海出身です。",
  "language": "ja-JP",
  "voice": "nova",
  "speed": 1.0
}
```

**Response:** MP3 audio file (binary)

### POST `/api/self-intro/save-cards`

Saves generated sentences as Lianki flashcards.

**Request:**

```json
{
  "language": "ja-JP",
  "sentences": {
    "name": {
      "text": "私の名前は張偉です。",
      "audioUrl": "blob:..."
    },
    "from": {
      "text": "私は中国の上海出身です。",
      "audioUrl": "blob:..."
    }
  }
}
```

**Response:**

```json
{
  "success": true,
  "cardsCreated": 6,
  "message": "6 self-introduction cards saved successfully!"
}
```

## Data Model

Cards are saved to MongoDB with the following structure:

```typescript
{
  url: "lianki://self-intro/ja-JP/name/1709876543210",
  title: "[Self-Intro ja-JP] 私の名前は張偉です。",
  card: Card, // FSRS card object
  selfIntro: {
    language: "ja-JP",
    questionId: "name",
    text: "私の名前は張偉です。"
  }
}
```

## Cost Estimation

- **Translation**: GPT-4o-mini (~$0.0015 per 6 questions)
- **TTS**: ~$0.015 per 1K characters (~$0.001 per question)
- **Total per session**: ~$0.01-0.02 USD

## Future Enhancements

- Store audio files in cloud storage (S3, Cloudflare R2) instead of regenerating
- Add pronunciation practice with speech recognition
- Support for custom questions
- Accent/dialect selection for regional variations
- Voice cloning to match user's voice characteristics
- Community sharing of self-introductions
