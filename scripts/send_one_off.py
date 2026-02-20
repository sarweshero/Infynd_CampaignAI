import asyncio
import sys
from pathlib import Path

# Ensure project root is importable
root = Path(__file__).resolve().parents[1]
sys.path.append(str(root))

from infynd_campaign_engine.app.services.sendgrid_service import send_email

async def main():
    subject = "[Xyndrix Alert] Exciting New Tool for Developers: Introducing CodeEditor"
    body = (
        "Dear Carol White, I hope this message finds you well. I'm reaching out from Xyndrix, a company committed to providing innovative solutions that streamline your work processes. "
        "I wanted to bring to your attention our latest offering - CodeEditor, a tool designed specifically for developers like yourself. This new product is set to revolutionize the way you write and manage code, making it more efficient and less prone to errors. "
        "[PRODUCT_LINK] provides a comprehensive overview of CodeEditor's features and benefits. I believe this tool will significantly enhance your team's productivity and deliver superior outcomes for DevStudio. "
        "I would love the opportunity to discuss further how CodeEditor can be integrated into your workflow at a time that suits you best, Morning. Let's set up a call and explore the potential this tool holds for your team. Looking forward to hearing from you soon. Best regards, [Your Name] Xyndrix"
    )
    cta = "https://xyndrix.com/codeeditor"
    html = body.replace('[PRODUCT_LINK]', cta).replace('[Your Name]', 'Alex from Xyndrix').replace('Morning','morning') + f"<br><br><a href='{cta}'>{cta}</a>"

    print('Attempting send to carol.white@devstudio.com')
    res = await send_email('carol.white@devstudio.com', subject, html, 'manual')
    print('Result:', res)

if __name__ == '__main__':
    asyncio.run(main())
