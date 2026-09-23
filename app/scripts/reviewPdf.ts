// ASCII PDF fixture, generated in memory: no user documents or external assets.
export function reviewPdf() {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const pages=[];
  for(let i=0;i<100;i++){
    const page=objects.length+1;pages.push(`${page} 0 R`);
    const stream=`BT /F1 20 Tf 40 750 Td (Algorithms - Section ${i+1}) Tj /F1 12 Tf ` + Array.from({length:32},(_,j)=>`0 -20 Td (Line ${j+1}: Panel motion over a long PDF document.) Tj`).join(" ")+" ET";
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents ${page+1} 0 R >>`, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objects[1]=`<< /Type /Pages /Count ${pages.length} /Kids [${pages.join(" ")}] >>`;
  let pdf="%PDF-1.4\n";const offsets=[0];
  objects.forEach((body,i)=>{offsets.push(pdf.length);pdf+=`${i+1} 0 obj\n${body}\nendobj\n`});
  const xref=pdf.length;pdf+=`xref\n0 ${offsets.length}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,"0")} 00000 n \n`).join("")+`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf).buffer;
}
