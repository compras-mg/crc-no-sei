# CRC no SEI · Minas Gerais — versão 0.2.0

A nova versão acrescenta suporte a CPF, mantendo CNPJ numérico e alfanumérico e a correção de reconhecimento do endereço do SEI que utiliza id_protocolo.

## O que mudou

- Entrada manual de CPF ou CNPJ, com validação dos dígitos verificadores e preservação dos zeros iniciais.
- Busca de CPFs e CNPJs nos documentos com camada de texto. CPFs com pontuação podem ter espaços e quebras entre os caracteres; CPFs compactos precisam estar imediatamente após o rótulo CPF para reduzir confusão com outros números.
- Seleção automática de Pessoa Física e preenchimento do campo CPF na consulta pública do CAGEF. A consulta só continua depois que o servidor confirma a ativação do campo correto.
- Nome de pessoa física obtido no CAGEF ou no CRC, sem atribuir por proximidade nomes encontrados nos documentos.
- Conferência do CPF no bloco IDENTIFICAÇÃO do CRC antes de liberar a inclusão. Um CPF apenas mencionado em outra seção não confirma a identidade do fornecedor.
- Preparação do arquivo e metadados no SEI, identificação da operação por CPF e proteção contra inclusão duplicada, conforme o fluxo existente.
- Interface atualizada para CPF/CNPJ e diagnóstico sem os identificadores ou nomes.

## Instalação da atualização

1. Extraia crc-sei-0.2.0.zip em uma pasta permanente.
2. Guarde uma cópia da pasta da versão instalada. Substitua seu conteúdo pelos arquivos da pasta crc-sei-extension do novo ZIP. Use a mesma pasta que o Chrome já carrega; o manifest.json deve ficar diretamente nela.
3. Em chrome://extensions, clique em Recarregar no cartão da extensão e confirme a versão 0.2.0.
4. Atualize a aba do processo no SEI e abra o botão CRC.
5. Informe um CPF válido ou use Buscar CPFs e CNPJs nos documentos. Confira se o identificador selecionado pertence ao fornecedor desejado.
6. Emita o CRC e confira o PDF. Para a primeira validação real, use a opção de revisar o formulário antes de salvar em um processo adequado.

## Verificação e limites

Passaram 219 testes automatizados, abrangendo os fluxos anteriores de CNPJ, CPF com zero inicial, dígitos inválidos, leitura com espaços de PDF, consulta e emissão com respostas simuladas, rejeição de identidade divergente, seleção do campo correto, inclusão simulada no SEI, prevenção de duplicidade e diagnóstico sem dados pessoais.

No formulário público real do CAGEF, foi conferida a presença de Pessoa Física e cpfBox e confirmada a troca de modo por resposta do servidor (campo CPF visível e campo CNPJ oculto). Nenhum CPF foi enviado nessas verificações e nenhum CRC real foi emitido ou incluído em processo. A emissão e inclusão reais por CPF ainda precisam de validação no ambiente da equipe.

PDFs digitalizados sem camada de texto continuam exigindo entrada manual; a extensão não faz OCR. A emissão depende da disponibilidade do CRC para o fornecedor no CAGEF e das permissões da unidade no SEI. As permissões da extensão não foram ampliadas.

## Manutenção

O ZIP contém o código-fonte e os testes. Para executá-los, use uma versão de Node compatível com jsdom 30.1.2 (por exemplo, Node 24.22.1), instale as dependências de desenvolvimento declaradas no package.json e execute npm test. As dependências de teste não são necessárias para instalar a extensão no Chrome.
