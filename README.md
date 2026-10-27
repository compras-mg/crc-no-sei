# CRC no SEI · Minas Gerais

Extensão para Google Chrome que identifica CPF e CNPJ nos documentos de um processo do SEI/MG, consulta o CAGEF e permite emitir e incluir o Certificado de Registro Cadastral como documento externo.

A versão 0.2.1 corrige a leitura da confirmação de Pessoa Física do CAGEF. A versão 0.2.0 rejeitava a resposta real do portal por tratá-la como JSON estrito.

## Download

**[Baixar a versão 0.2.1](https://github.com/compras-mg/crc-no-sei/releases/download/v0.2.1/crc-sei-0.2.1.zip)**

[Ver versões disponíveis](https://github.com/compras-mg/crc-no-sei/releases)

## Instalar no Chrome

1. Baixe o ZIP acima e extraia os arquivos em uma pasta permanente no computador.
2. Abra `chrome://extensions` e ative **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação** e selecione a pasta `crc-sei-extension` que contém o arquivo `manifest.json`.
4. Abra ou atualize a aba de um processo no SEI/MG. O botão **CRC** aparece na barra de ações do processo.

O download pelo GitHub exige a instalação manual acima. A extensão não está publicada na Chrome Web Store.

## Atualizar

Guarde uma cópia da pasta anterior. Substitua os arquivos na mesma pasta que o Chrome já carrega, clique em **Recarregar** no cartão da extensão em `chrome://extensions` e atualize a aba do SEI. Confira a versão **0.2.1**.

## Utilizar

Informe um CPF ou CNPJ ou busque os identificadores nos documentos. Escolha o fornecedor, solicite a emissão e confira o PDF. Depois, solicite a inclusão no SEI. Na primeira validação, use a opção de revisar o formulário antes de salvar em um processo adequado.

CPFs e CNPJs são validados pelos dígitos verificadores. Para CPF, a extensão seleciona Pessoa Física no CAGEF e confere o identificador no bloco IDENTIFICAÇÃO do CRC antes de permitir a inclusão.

## Verificação e limites

A versão 0.2.1 passou em **222 testes automatizados**, com respostas simuladas para emissão e inclusão. A seleção de Pessoa Física e a ativação do campo CPF foram verificadas no formulário público real do CAGEF, sem informar CPF. A emissão e inclusão de um CRC real por CPF ainda precisam de validação no ambiente de uso.

A leitura automática cobre documentos com camada de texto; não há OCR de imagens digitalizadas. CPFs sem pontuação precisam estar imediatamente após o rótulo CPF. O funcionamento depende da disponibilidade do CAGEF, das permissões da unidade e da estrutura do SEI/MG.

## Dados e privacidade

Os documentos são processados no navegador. Os identificadores sem nome são consultados no CAGEF para completar a lista. O PDF é emitido para o fornecedor escolhido e enviado ao SEI quando o usuário solicita a inclusão. A extensão não utiliza serviço externo de IA ou telemetria.

As permissões cobrem os domínios do SEI/MG e do CAGEF. O pacote não inclui documentos ou dados reais de processos. Os identificadores nos testes são exemplos de validação, não cadastros consultados.

## Documentação e manutenção

- [Novidades e instruções da versão 0.2.1](ATUALIZACAO.md)
- [Manual completo no pacote](LEIA-ME.html)
- [Avisos de componentes de terceiros](THIRD-PARTY-NOTICES.txt)

Para executar os testes, use uma versão de Node compatível com jsdom 30.1.2, como Node 24.22.1:

```sh
npm install
npm test
```

As dependências de desenvolvimento não são necessárias para instalar a extensão no Chrome.
