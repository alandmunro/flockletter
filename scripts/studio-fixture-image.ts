import sharp from 'sharp';

// Fictional artwork for cross-client and brand-isolation tests.
export async function studioFixtureImage(background: string) {
  const landscape = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="180" viewBox="0 0 480 180">
        <rect width="480" height="180" fill="#efe2d5"/><circle cx="364" cy="40" r="23" fill="#f7ae7c"/>
        <path d="M0 132L92 45l47 39 65-55 105 95 74-47 97 55v48H0z" fill="#a0aeb0"/>
        <path d="M0 151l94-38 71 21 79-76 102 76 53-31 81 32v45H0z" fill="${background}"/>
        <path d="M217 84l27-26 43 32-25-7-13 8-11-16z" fill="#eee8dd"/>
        <path d="M0 155l105-14 64 16 78-12 107 17 74-13 52 7v24H0z" fill="#344749"/>
      </svg>`;
  return sharp(Buffer.from(landscape)).png().toBuffer();
}
