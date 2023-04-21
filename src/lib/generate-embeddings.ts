import dotenv from 'dotenv'
dotenv.config()

import { createClient } from '@supabase/supabase-js'
import {sanityWriteClient} from '~/utils/sanity-server'

//@ts-ignore
import {default as sanityToMarkdown} from '@sanity/block-content-to-markdown'
import { createHash } from 'crypto'
//@ts-ignore
import { Content, Root } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { mdxFromMarkdown, MdxjsEsm } from 'mdast-util-mdx'
import { toMarkdown } from 'mdast-util-to-markdown'
import { toString } from 'mdast-util-to-string'
import { mdxjs } from 'micromark-extension-mdxjs'
import { filter } from 'unist-util-filter'
import GithubSlugger from 'github-slugger'
import { u } from 'unist-builder'
import { Configuration, OpenAIApi } from 'openai'
import { inspect } from 'util'

console.log(process.env)

const serializers = {
  types: {
    code: (props: any) => '```' + props.node.language + '\n' + props.node.code + '\n```',
    bodyTweet: (props: any) => {
      return `\> ${sanityToMarkdown(props.node.text, {serializers})} 
      
      ${props.node.url}`
    },
    bodyImage: (props: any) => {
      return `![${props.node.alt}](${props.node.image.url})`
    }
  }
}

function splitTreeBy(tree: Root, predicate: (node: Content) => boolean) {
  return tree.children.reduce<Root[]>((trees: any, node: any) => {
    const [lastTree] = trees.slice(-1)

    if (!lastTree || predicate(node)) {
      const tree: Root = u('root', [node])
      return trees.concat(tree)
    }

    lastTree.children.push(node)
    return trees
  }, [])
}

type Section = {
  content: string
  heading?: string
  slug?: string
}

type ProcessedMdx = {
  checksum: string
  sections: Section[]
}

function processMarkdownForSearch(content: string) : ProcessedMdx {
  const checksum = createHash('sha256').update(content).digest('base64')

  const mdxTree = fromMarkdown(content, {
    extensions: [mdxjs()],
    mdastExtensions: [mdxFromMarkdown()],
  })

   const mdTree = filter(
    mdxTree,
    (node) =>
      ![
        'mdxjsEsm',
        'mdxJsxFlowElement',
        'mdxJsxTextElement',
        'mdxFlowExpression',
        'mdxTextExpression',
      ].includes(node.type)
  )

  if (!mdTree) {
    return {
      checksum,
      sections: [],
    }
  }

  const sectionTrees = splitTreeBy(mdTree, (node) => node.type === 'heading')

  const slugger = new GithubSlugger()

  const sections = sectionTrees.map((tree: any) => {
    const [firstNode] = tree.children

    const heading = firstNode.type === 'heading' ? toString(firstNode) : undefined
    const slug = heading ? slugger.slug(heading) : undefined

    return {
      content: toMarkdown(tree),
      heading,
      slug,
    }
  })

  return {
    checksum,
    sections,
  }

}

abstract class BaseEmbeddingSource {
  checksum?: string
  sections?: Section[]

  constructor(public source: string, public path: string, public parentPath?: string) {}

  abstract load(): Promise<{
    checksum: string
    sections: Section[]
  }>
}

class MarkdownEmbeddingSource extends BaseEmbeddingSource {
  type: 'markdown' = 'markdown'

  constructor(source: string, public sanityDoc: {body: any[], _id: string}, public parentFilePath?: string) {

    super(source, sanityDoc._id)
  }

  async load() {

    const { checksum, sections } = processMarkdownForSearch(sanityToMarkdown(this.sanityDoc.body, {serializers}))

    this.checksum = checksum

    this.sections = sections

    return {
      checksum,
      sections,
    }
  }
}

type EmbeddingSource = MarkdownEmbeddingSource

async function main() {
  const args = process.argv.slice(2)
  const shouldRefresh = args.includes('--refresh')

  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY ||
    !process.env.OPENAI_KEY
  ) {
    return console.log(
      'Environment variables NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and OPENAI_KEY are required: skipping embeddings generation'
    )
  }

  const supabaseClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    }
  )

  const embeddingSources : EmbeddingSource[] = await sanityWriteClient()
  .fetch<{body: any[], _id: string}[]>(`*[_type == "article"]`)
  .then(articles => {
      return articles.map<EmbeddingSource>(article => new MarkdownEmbeddingSource('sanity:articles', article))
  })

    console.log(`Discovered ${embeddingSources.length} pages`)

  if (!shouldRefresh) {
    console.log('Checking which pages are new or have changed')
  } else {
    console.log('Refresh flag set, re-generating all pages')
  }

  for(const embeddingSource of embeddingSources) {
    const { type, source, path, sanityDoc, parentPath } = embeddingSource
    try {
      const {checksum, sections} = await embeddingSource.load()
      const { error: fetchPageError, data: existingPage } = await supabaseClient
        .from('nods_page')
        .select('id, path, checksum, parentPage:parent_page_id(id, path)')
        .filter('path', 'eq', path)
        .limit(1)
        .maybeSingle()

      if (fetchPageError) {
        throw fetchPageError
      }

      type Singular<T> = T extends any[] ? undefined : T

      console.log({shouldRefresh, existingPage, checksum, path})

            // We use checksum to determine if this page & its sections need to be regenerated
      if (!shouldRefresh && existingPage?.checksum === checksum) {
        const existingParentPage = existingPage?.parentPage as Singular<
          typeof existingPage.parentPage
        >

        // If parent page changed, update it
        if (existingParentPage?.path !== parentPath) {
          console.log(`[${path}] Parent page has changed. Updating to '${parentPath}'...`)
          const { error: fetchParentPageError, data: parentPage } = await supabaseClient
            .from('nods_page')
            .select()
            .filter('path', 'eq', parentPath)
            .limit(1)
            .maybeSingle()

          if (fetchParentPageError) {
            throw fetchParentPageError
          }

          const { error: updatePageError } = await supabaseClient
            .from('nods_page')
            .update({ parent_page_id: parentPage?.id })
            .filter('id', 'eq', existingPage.id)

          if (updatePageError) {
            throw updatePageError
          }
        }
        continue
      }

      if (existingPage) {
        if (!shouldRefresh) {
          console.log(
            `[${path}] Docs have changed, removing old page sections and their embeddings`
          )
        } else {
          console.log(`[${path}] Refresh flag set, removing old page sections and their embeddings`)
        }

        const { error: deletePageSectionError } = await supabaseClient
          .from('nods_page_section')
          .delete()
          .filter('page_id', 'eq', existingPage.id)

        if (deletePageSectionError) {
          throw deletePageSectionError
        }
      }
      const { error: fetchParentPageError, data: parentPage } = await supabaseClient
        .from('nods_page')
        .select()
        .filter('path', 'eq', parentPath)
        .limit(1)
        .maybeSingle()

      if (fetchParentPageError) {
        throw fetchParentPageError
      }

      // Create/update page record. Intentionally clear checksum until we
      // have successfully generated all page sections.
      const { error: upsertPageError, data: page } = await supabaseClient
        .from('nods_page')
        .upsert(
          {
            checksum: null,
            path,
            type,
            source,
            parent_page_id: parentPage?.id,
          },
          { onConflict: 'path' }
        )
        .select()
        .limit(1)
        .single()

      if (upsertPageError) {
        throw upsertPageError
      }

      console.log(`[${path}] Adding ${sections.length} page sections (with embeddings)`)
      for (const { slug, heading, content } of sections) {
        // OpenAI recommends replacing newlines with spaces for best results (specific to embeddings)
        const input = content.replace(/\n/g, ' ')

        try {
          const configuration = new Configuration({
            apiKey: process.env.OPENAI_KEY,
          })
          const openai = new OpenAIApi(configuration)

          const embeddingResponse = await openai.createEmbedding({
            model: 'text-embedding-ada-002',
            input,
          })

          if (embeddingResponse.status !== 200) {
            throw new Error(inspect(embeddingResponse.data, false, 2))
          }

          const [responseData] = embeddingResponse.data.data

          const { error: insertPageSectionError, data: pageSection } = await supabaseClient
            .from('nods_page_section')
            .insert({
              page_id: page.id,
              slug,
              heading,
              content,
              token_count: embeddingResponse.data.usage.total_tokens,
              embedding: responseData?.embedding,
            })
            .select()
            .limit(1)
            .single()

          if (insertPageSectionError) {
            throw insertPageSectionError
          }
        } catch (err) {
          // TODO: decide how to better handle failed embeddings
          console.error(
            `Failed to generate embeddings for '${path}' page section starting with '${input.slice(
              0,
              40
            )}...'`
          )

          throw err
        }
      }

      // Set page checksum so that we know this page was stored successfully
      const { error: updatePageError } = await supabaseClient
        .from('nods_page')
        .update({ checksum })
        .filter('id', 'eq', page.id)

      if (updatePageError) {
        throw updatePageError
      }
    } catch (err) {
      console.error(`Error processing ${type} source ${source}`, err)
    }
  }
}

main().catch((err) => console.error(err))