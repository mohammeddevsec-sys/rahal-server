import express from 'express';
import OpenAI from 'openai';
import dotenv from 'dotenv';
dotenv.config();

const router = express.Router();

let openaiClient = null;
if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== '×××××××××××') {
  openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

router.post('/', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ ok: false, error: 'No text provided' });
    
    if (!openaiClient) {
      return res.json({ ok: false, error: 'AI not configured' });
    }

    const prompt = "أنت مساعد ملاحة عراقي اسمك 'رحال'. تفهم اللهجة العراقية والعامية بطلاقة تامة.\n" +
      "المستخدم يقول: '" + text + "'.\n" +
      "أرجع النتيجة بصيغة JSON فقط:\n" +
      "{\n" +
      "  \"action\": \"NEARBY\" أو \"SEARCH\" أو \"ROUTE\" أو \"SPEAK\",\n" +
      "  \"query\": \"اسم المكان أو الوسم الإنجليزي\",\n" +
      "  \"reply\": \"رد صوتي قصير باللغة العربية الفصحى المبسطة فقط\"\n" +
      "}\n" +
      "قواعد هامة جداً:\n" +
      "1. ممنوع منعاً باتاً استخدام الكلمات العراقية (مثل: هسة، عيني، شلون، أكو، تدلل) في حقل reply. يجب أن يكون الرد بالفصحى المدرسية البسيطة (مثل: حاضر، جاري البحث، تم حساب المسار).\n" +
      "2. إذا سأل عن فئة عامة (بنجرجي، مستشفى، جامعة، شرطة، مطعم، وقود)، استخدم action: \"NEARBY\" و query: الوسم الإنجليزي (car_repair, hospital, university, police, restaurant, fuel).\n" +
      "3. إذا سأل عن مكان محدد بالاسم (مثل: مستشفى الكندي، جامعة بغداد)، استخدم action: \"SEARCH\" و query بالاسم.\n" +
      "4. إذا قال (نروح لـ، ابدأ الرحلة إلى، روح لـ) + محافظة/مدينة، استخدم action: \"ROUTE\" و query باسم الوجهة.\n" +
      "5. لغير ذلك، استخدم action: \"SPEAK\".";

    const response = await openaiClient.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'system', content: prompt }],
        response_format: { type: 'json_object' }
    });

    const aiText = response.choices[0].message.content;
    const jsonResult = JSON.parse(aiText);
    
    res.json({ ok: true, result: jsonResult });
  } catch (err) {
    console.error('AI Error:', err);
    res.status(500).json({ ok: false, error: 'AI failed' });
  }
});

export default router;
