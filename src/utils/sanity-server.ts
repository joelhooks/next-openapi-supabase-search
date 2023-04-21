import {createClient} from '@sanity/client'

export const sanityWriteClient = () => {
  return createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: 'production',
  useCdn: false, // `false` if you want to ensure fresh data
  apiVersion: '2021-10-19',
  token: process.env.SANITY_API_TOKEN,
})
}
